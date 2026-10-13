#!/usr/bin/env python3
"""DSH desktop inbox client. No host/session access; queue-only, bounded wait."""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time

SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}\Z")


def identifier(value):
    if not SAFE_ID.fullmatch(value):
        raise argparse.ArgumentTypeError("Use a safe nonempty ID without path separators")
    return value


def read_json(path):
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected JSON object: {path}")
    return value


def emit(value):
    print(json.dumps(value, ensure_ascii=False, indent=2), flush=True)


def receipt_result(path, session=None):
    receipt = read_json(path)
    if session is not None and receipt.get("sessionId") != session:
        raise ValueError("Existing receipt belongs to another session; do not reuse this ID")
    emit(receipt)
    if receipt.get("ok") is True and receipt.get("accepted") is True:
        print("Accepted, not completed. Do not resend this instruction.")
        return 0
    print("Receipt did not confirm acceptance. Do not retry blindly.", file=sys.stderr)
    return 1


def read_index(directory):
    index = read_json(directory / "sessions.json")
    items = index.get("items")
    if not isinstance(items, list) or not isinstance(index.get("count"), int):
        raise ValueError("Invalid sessions index; consult the host maintainer")
    return index, [x for x in items if isinstance(x, dict) and x.get("origin") != "subagent"]


def wait_receipt(directory, request_id, session, timeout):
    receipt = directory / "receipts" / f"{request_id}.json"
    deadline = time.monotonic() + timeout
    while True:
        if receipt.exists():
            return receipt_result(receipt, session)
        if time.monotonic() >= deadline:
            emit({"state": "awaiting-receipt", "id": request_id,
                  "pendingFileExists": (directory / f"{request_id}.json").exists(),
                  "receiptPath": str(receipt),
                  "note": "May be pending or already consumed. Check this ID; do not repost or change ID."})
            return 2
        time.sleep(min(0.25, max(0, deadline - time.monotonic())))


def publish(request, directory):
    target = directory / f"{request['id']}.json"
    if target.exists():
        if read_json(target) != request:
            raise ValueError("ID already has a different pending request; refusing overwrite")
        return False
    fd, name = tempfile.mkstemp(dir=directory, prefix=".codex-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(json.dumps(request, ensure_ascii=False, indent=2) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(name, target)  # Atomic complete-file publication, never overwrite.
        except FileExistsError:
            if read_json(target) != request:
                raise ValueError("Concurrent request with different content; refusing overwrite")
            return False
        return True
    finally:
        Path(name).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["list", "send", "status"])
    parser.add_argument("--dir", type=Path, default=Path(os.environ.get("DSH_HOME") or Path.home() / ".dsh") / "inbox")
    parser.add_argument("--session", type=identifier)
    parser.add_argument("--id", type=identifier)
    parser.add_argument("--text-file", type=Path)
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args()
    if not 0 <= args.timeout <= 60:
        parser.error("timeout must be between 0 and 60 seconds")
    directory = args.dir.expanduser().resolve()
    try:
        if args.command == "list":
            index, items = read_index(directory)
            emit({"generatedAt": index.get("generatedAt"), "count": len(items), "items": items})
            return 0 if items else 2
        if not args.id:
            parser.error("--id is required; keep it stable for this logical instruction")
        if args.command == "status":
            return wait_receipt(directory, args.id, args.session, args.timeout)
        if not args.session or not args.text_file:
            parser.error("send requires --session and --text-file")
        text = args.text_file.read_text(encoding="utf-8")
        if not text.strip() or len(text.encode("utf-8")) > 200000:
            parser.error("text must be nonblank and at most 200000 UTF-8 bytes")
        receipt = directory / "receipts" / f"{args.id}.json"
        if receipt.exists():
            return receipt_result(receipt, args.session)
        index, items = read_index(directory)
        if index["count"] <= 0:
            emit({"state": "not-ready", "note": "No host sessions. No request written."})
            return 2
        if not any(x.get("sessionId") == args.session for x in items):
            raise ValueError("Target session absent from host index; confirm identity before sending")
        request = {"sessionId": args.session, "text": text, "mode": "queue", "id": args.id, "from": "codex"}
        created = publish(request, directory)
        emit({"state": "request-written" if created else "existing-request-reused", "id": args.id,
              "sessionId": args.session, "mode": "queue"})
        return wait_receipt(directory, args.id, args.session, args.timeout)
    except FileNotFoundError as error:
        emit({"state": "unavailable", "message": str(error), "note": "Do not loop or blindly repost."})
        return 2
    except (OSError, ValueError, TypeError, KeyError) as error:
        emit({"state": "error", "message": str(error)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
