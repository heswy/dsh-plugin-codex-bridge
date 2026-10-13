import http.server,json,subprocess,tempfile,threading,uuid
from pathlib import Path
script=str(Path(__file__).with_name('new_task.py'))
with tempfile.TemporaryDirectory(prefix='codex2dsh-helper-test-') as d:
 root=Path(d).resolve();workspace=root/'workspace';workspace.mkdir();calls=[];fault=False
 class Handler(http.server.BaseHTTPRequestHandler):
  def log_message(self,*a):pass
  def do_GET(self):
   self.send_response(200);self.send_header('Set-Cookie','dsh=test-cookie');self.end_headers();self.wfile.write(b'ok')
  def do_POST(self):
   data=json.loads(self.rfile.read(int(self.headers['Content-Length'])));method=data['method'];args=data['payload']['args'];calls.append((method,args))
   assert self.headers['Origin']==f'http://127.0.0.1:{self.server.server_port}'
   assert self.headers['Cookie']=='dsh=test-cookie'
   if fault and method=='session/create':self.connection.shutdown(2);self.connection.close();return
   values={'workspace/create':{'created':True,'workspace':{'workspaceId':'workspace-test'}},'session/create':{'sessionId':'session-test'},'session/rename':{},'session/list':{'items':[{'sessionId':'session-test','cwd':str(workspace),'origin':None}]},'session/prompt':{'accepted':True,'queuedBehindRunningTurn':False}}
   self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps({'result':{'ok':True,'value':values[method]}}).encode())
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
 try:
  auth=root/'auth';auth.write_text(f'http://127.0.0.1:{server.server_port}/?token=test-auth');auth.chmod(0o600)
  text=root/'prompt';text.write_text('Only write a mock introduction. No Git/PR task.')
  supervisor=str(uuid.uuid4())
  def command(state):return ['python3',script,'--auth-url-file',str(auth),'--workspace',str(workspace),'--title','Mock test','--text-file',str(text),'--supervisor-thread',supervisor,'--request-id','mock-request-1','--state-file',str(state)]
  state=root/'success.json';r=subprocess.run(command(state),capture_output=True,text=True);assert r.returncode==0,(r.stdout,r.stderr)
  result=json.loads(r.stdout);assert result['status']=='accepted'
  assert [m for m,_ in calls]==['workspace/create','session/create','session/rename','session/list','session/prompt']
  payload=calls[-1][1]['request'];assert payload['mode']=='queue' and payload['requestId']=='mock-request-1'
  assert supervisor in payload['content'][0]['text'];assert '--thread '+supervisor in payload['content'][0]['text']
  assert 'test-auth' not in state.read_text() and 'test-cookie' not in state.read_text()
  assert state.stat().st_mode & 0o777==0o600
  before=len(calls);r=subprocess.run(command(state),capture_output=True,text=True);assert r.returncode==0 and len(calls)==before
  assert json.loads(r.stdout)['status']=='already-accepted'
  print('PASS: workspace/session/rename/verified queue; supervisor binding; private state; repeated run sends nothing.')
  fault=True;state=root/'unknown.json';r=subprocess.run(command(state),capture_output=True,text=True);assert r.returncode==2 and json.loads(r.stdout)['status']=='unknown'
  before=len(calls);r=subprocess.run(command(state),capture_output=True,text=True);assert r.returncode==2 and json.loads(r.stdout)['status']=='blocked' and len(calls)==before
  print('PASS: unknown session creation blocks retry; no duplicate session or prompt.')
 finally:server.shutdown();server.server_close()
