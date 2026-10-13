window.__ModuleLoader__.load({
	id: "dsh-workspace-sync",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var h = react.createElement;
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		// Hand-written browser bundle: no bundler, no JSX, and only the seeded
		// specifiers may be required. Colors come from --dsw-* theme tokens.

		var NS = "workspaceSync";
		var ENTRY_ID = "workspace-sync";
		var ROUTE = "api/workspace-sync";

		//#region i18n
		var zh = {
			action: "同步工作区",
			tipIdle: "把其他 DSH 进程新建的工作区同步进来（无需重启）",
			tipBusy: "正在同步…",
			tipAdded: "已添加 {count} 个工作区",
			tipNone: "没有需要添加的工作区",
			tipFailed: "同步失败：{message}",
			tipUnreachable: "同步接口不可用（宿主半未挂载？）",
		};

		var en = {
			action: "Sync workspaces",
			tipIdle: "Pull workspaces registered by another DSH process into this window (no restart)",
			tipBusy: "Syncing…",
			tipAdded: "Added {count} workspace(s)",
			tipNone: "Nothing to add",
			tipFailed: "Sync failed: {message}",
			tipUnreachable: "Sync endpoint unavailable (host half not mounted?)",
		};
		//#endregion

		//#region helpers
		function makeT(t) {
			return function translate(key, values) {
				var template = typeof t === "function" ? t(key) : undefined;
				if (typeof template !== "string" || template.length === 0 || template === key) {
					template = zh[key];
				}
				if (typeof template !== "string") return key;
				if (values === undefined) return template;
				return template.replace(/\{(\w+)\}/g, function (match, name) {
					return values[name] === undefined ? match : String(values[name]);
				});
			};
		}

		async function postSync() {
			var response = await fetch(ROUTE + "?action=sync", { method: "POST" });
			var body = null;
			try {
				body = await response.json();
			} catch (error) {
				throw new Error("HTTP " + response.status);
			}
			if (body !== null && body.ok === true) return body.data;
			var message = body !== null && body.error !== undefined ? body.error.message : "HTTP " + response.status;
			throw new Error(message);
		}

		var css =
			".wsync-root{display:inline-flex;align-items:center}" +
			".wsync-icon{display:inline-flex;transition:transform .25s ease}" +
			".wsync-spin{animation:wsync-spin 1s linear infinite}" +
			"@keyframes wsync-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}" +
			"@media (prefers-reduced-motion: reduce){.wsync-spin{animation:none}}";

		function ensureStyle() {
			try {
				if (document.querySelector('style[data-plugin="dsh-workspace-sync"]') !== null) return;
				var tag = document.createElement("style");
				tag.setAttribute("data-plugin", "dsh-workspace-sync");
				tag.textContent = css;
				document.head.appendChild(tag);
			} catch (error) {
				/* styling is cosmetic; never break the button for it */
			}
		}
		//#endregion

		//#region footer action
		/**
		 * Refresh control at the sidebar foot. The click only asks the host to run
		 * one reconciliation pass; the sidebar itself updates from the workspace
		 * follow stream the registry publishes, so nothing here touches the list.
		 */
		function SyncAction(props) {
			var t = makeT(props !== null && props !== undefined ? props.t : undefined);
			var state = react.useState({ busy: false, result: null });
			var current = state[0];
			var setState = state[1];
			var timerRef = react.useRef(null);

			react.useEffect(function () {
				ensureStyle();
				return function () {
					if (timerRef.current !== null) clearTimeout(timerRef.current);
				};
			}, []);

			var run = react.useCallback(function () {
				if (current.busy) return;
				setState({ busy: true, result: null });
				postSync().then(
					function (data) {
						var added = data !== null && Array.isArray(data.added) ? data.added.length : 0;
						var failed = data !== null && Array.isArray(data.failed) ? data.failed.length : 0;
						setState({
							busy: false,
							result: failed > 0 && added === 0
								? { tone: "failed", count: 0, message: "HTTP 200 / " + failed + " failed" }
								: { tone: added > 0 ? "added" : "none", count: added, message: "" },
						});
					},
					function (error) {
						setState({ busy: false, result: { tone: "failed", count: 0, message: String(error && error.message ? error.message : error) } });
					},
				);
				if (timerRef.current !== null) clearTimeout(timerRef.current);
				timerRef.current = setTimeout(function () {
					timerRef.current = null;
					setState({ busy: false, result: null });
				}, 6000);
			}, [current.busy, setState]);

			var tip = t("tipIdle");
			if (current.busy) tip = t("tipBusy");
			else if (current.result !== null) {
				if (current.result.tone === "added") tip = t("tipAdded", { count: current.result.count });
				else if (current.result.tone === "none") tip = t("tipNone");
				else tip = t("tipFailed", { message: current.result.message });
			}

			var label = t("action");
			return h("span", { className: "wsync-root" },
				h(primitives.Tooltip, { label: tip, side: "top" },
					h(primitives.Button, {
						variant: "ghost",
						size: "sm",
						onClick: run,
						"aria-label": label,
						disabled: current.busy,
					},
						h("span", { className: current.busy ? "wsync-icon wsync-spin" : "wsync-icon" },
							h(primitives.IconRefreshOutlineRegular, { size: 16 })),
					)),
			);
		}
		//#endregion

		//#region plugin
		var inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(function () {
				return ctx.locale.register(NS, { zh: zh, en: en });
			}, "workspace-sync: dictionaries");

			ctx.slots.inject("sidebar.footer.action", function () {
				return ctx.slots.register({
					name: "sidebar.footer.action",
					id: ENTRY_ID,
					order: 30,
					label: function () { return zh.action; },
					locale: NS,
				}, SyncAction);
			});
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
