#!/usr/bin/env python3
"""Isolated HTTP control-plane integration with a real forwarding process (stdlib only)."""
import copy, http.cookiejar, json, os, pathlib, socket, socketserver, subprocess, sys, tempfile, threading, time, urllib.error, urllib.request
BIN=pathlib.Path(sys.argv[1] if len(sys.argv)>1 else 'target/debug/host-router').resolve()
ROOT=pathlib.Path(tempfile.mkdtemp(prefix='host-router-panel-'))
RESULT=[]
PROCS=[]
def ok(name):
    RESULT.append(name);print('PASS',name,flush=True)
def port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
def start(*args):
    log=(ROOT/f'process-{len(PROCS)}.log').open('w');p=subprocess.Popen([str(BIN),*map(str,args)],stdout=log,stderr=log);log.close();PROCS.append(p);return p
def stop(p):
    if p.poll() is None:p.terminate();p.wait(timeout=15)
def wait_for(check):
    for _ in range(150):
        try:
            if check():return
        except (OSError,AssertionError):pass
        time.sleep(.05)
    raise AssertionError('timed out')
class Echo(socketserver.BaseRequestHandler):
    def handle(self):
        while True:
            data=self.request.recv(65536)
            if not data:break
            self.request.sendall(data)
class Client:
    def __init__(self,base):self.base=base;self.jar=http.cookiejar.CookieJar();self.opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar));self.csrf=''
    def call(self,path,method='GET',data=None,expected=200,headers=None):
        h={'Content-Type':'application/json','X-Requested-With':'host-router-panel','X-CSRF-Token':self.csrf}
        if headers:h.update(headers)
        r=urllib.request.Request(self.base+path,data=None if data is None else json.dumps(data).encode(),method=method,headers=h)
        try:res=self.opener.open(r,timeout=15)
        except urllib.error.HTTPError as e:res=e
        body=res.read();assert res.code==expected,(path,res.code,expected,body[:500])
        try:parsed=json.loads(body)
        except ValueError:parsed=body.decode()
        return parsed,res.headers
    def login(self,username,password):
        d,h=self.call('api/login','POST',{'username':username,'password':password});self.csrf=d['csrf'];return h
try:
    cfg=ROOT/'config.json';subprocess.run([str(BIN),'-c',str(cfg),'init'],check=True,capture_output=True)
    data=ROOT/'data';httpport=port();front=port()
    core=start('-c',cfg,'serve');wait_for(lambda:cfg.with_suffix('.sock').exists())
    args=['-c',cfg,'panel','--data-dir',data,'--listen',f'127.0.0.1:{httpport}','--origin',f'http://127.0.0.1:{httpport}','--base-path','/console/']
    refused=subprocess.run([str(BIN),'-c',str(cfg),'panel','--data-dir',str(data),'--listen',f'0.0.0.0:{httpport}'],capture_output=True,text=True)
    assert refused.returncode!=0 and '--allow-public-http' in refused.stderr
    assert not data.exists()
    args[args.index('--listen')+1]=f'0.0.0.0:{httpport}'
    args.append('--allow-public-http')
    ok('public HTTP requires explicit opt-in before credentials or listener creation')
    panel=start(*args);base=f'http://127.0.0.1:{httpport}/console/';c=Client(base)
    wait_for(lambda:urllib.request.urlopen(base,timeout=1).status==200)
    creds=(data/'管理员登录信息.txt').read_text();username=creds.split('管理员账号：')[1].splitlines()[0];password=creds.split('初始密码：')[1].splitlines()[0]
    assert (data/'admin.json').stat().st_mode&0o777==0o600
    assert (data/'管理员登录信息.txt').stat().st_mode&0o777==0o600
    assert password not in (data/'admin.json').read_text()
    ok('random bootstrap account, private credential file, salted password hash')
    for endpoint in ['me','config','status','backups','audit']:
        c.call('api/'+endpoint,expected=401)
    c.call('api/config','PUT',{},401)
    c.call('api/backups/nope','POST',{'revision':'x'},401)
    ok('all administrative endpoints require authentication')
    c.call('api/login','POST',{'username':username,'password':password},403,{'Origin':'https://attacker.example'})
    c.call('api/login','POST',{'username':username,'password':password},403,{'X-Requested-With':''})
    c.call('api/login','POST',{'username':username,'password':'wrong'},401)
    headers=c.login(username,password)
    assert 'HttpOnly' in headers['Set-Cookie'] and 'SameSite=Strict' in headers['Set-Cookie'] and 'Path=/console/' in headers['Set-Cookie']
    assert headers['Cache-Control']=='no-store'
    assert "frame-ancestors 'none'" in headers['Content-Security-Policy']
    c.call('api/logout','POST',{},403,{'X-CSRF-Token':'wrong'})
    c.call('api/logout','POST',{},403,{'Origin':'https://evil.example'})
    ok('login origin protection, CSRF validation, cookie and browser security headers')
    original,_=c.call('api/config');changed=copy.deepcopy(original['config'])
    echo=socketserver.ThreadingTCPServer(('127.0.0.1',0),Echo);echo.daemon_threads=True;threading.Thread(target=echo.serve_forever,daemon=True).start()
    rule={'listen':f'127.0.0.1:{front}','domain':'panel.test','target':f'127.0.0.1:{echo.server_address[1]}','protocol':'tcp','note':'control-plane integration'}
    changed['rules']=[rule]
    c.call('api/config','PUT',{'config':changed,'revision':original['revision']})
    def forwarded():
        s=socket.create_connection(('127.0.0.1',front),timeout=3);payload=b'GET / HTTP/1.1\r\nHost: panel.test\r\n\r\n';s.sendall(payload);assert s.recv(1024)==payload;return s
    connection=forwarded()
    ok('API transaction creates a real HTTP Host forwarding listener')
    current,_=c.call('api/config');changed=current['config'];changed['dns_refresh_seconds']=44
    c.call('api/config','PUT',{'config':changed,'revision':current['revision']})
    connection.sendall(b'connection-preserved');assert connection.recv(100)==b'connection-preserved'
    connection.close()
    ok('hot settings apply preserves existing TCP connection')
    c.call('api/config','PUT',{'config':changed,'revision':original['revision']},409)
    current,_=c.call('api/config');bad=copy.deepcopy(current['config']);bad['rules'].append(rule)
    c.call('api/config','PUT',{'config':bad,'revision':current['revision']},400)
    assert c.call('api/config')[0]==current
    with socket.socket() as held:
        held.bind(('127.0.0.1',0));held.listen()
        bad=copy.deepcopy(current['config']);bad['rules'].append({**rule,'listen':f'127.0.0.1:{held.getsockname()[1]}','domain':'blocked.test'})
        c.call('api/config','PUT',{'config':bad,'revision':current['revision']},400)
        assert c.call('api/config')[0]==current
        forwarded().close()
    ok('stale revision, duplicate rule and bind conflict reject atomically')
    bad=copy.deepcopy(current['config']);bad['dns_refresh_seconds']=0
    c.call('api/validate','POST',bad,400)
    bad=copy.deepcopy(current['config']);bad['unknown']=True
    c.call('api/validate','POST',bad,422)
    bad=copy.deepcopy(current['config']);bad['max_tcp_connections']=42
    c.call('api/config','PUT',{'config':bad,'revision':current['revision']},400)
    c.call('api/config','PUT',{'config':current['config'],'revision':current['revision'],'offline':True},400)
    ok('core validation shared; online resource-limit edits and unsafe offline writes refused')
    entries,_=c.call('api/backups');earliest=entries[-1]['id']
    snapshot,_=c.call('api/backups/'+earliest);assert snapshot['rules']==[]
    c.call('api/backups/'+earliest,'POST',{'revision':current['revision']})
    assert c.call('api/config')[0]['config']['rules']==[]
    c.call('api/backups/%2e%2e%2fadmin','GET',expected=400)
    ok('download and restore backup; traversal blocked')
    for i in range(32):
        current,_=c.call('api/config');current['config']['dns_refresh_seconds']=i+1
        c.call('api/config','PUT',{'config':current['config'],'revision':current['revision']})
    assert len(c.call('api/backups')[0])==30
    ok('automatic backups bounded at thirty snapshots')
    stop(core);wait_for(lambda:not cfg.with_suffix('.sock').exists())
    assert not c.call('api/status')[0]['running']
    current,_=c.call('api/config');current['config']['rules']=[rule]
    c.call('api/config','PUT',{'config':current['config'],'revision':current['revision']},400)
    c.call('api/config','PUT',{'config':current['config'],'revision':current['revision'],'offline':True})
    core=start('-c',cfg,'serve');wait_for(lambda:cfg.with_suffix('.sock').exists());forwarded().close()
    c.call('api/service/stop','POST',{},403)
    ok('offline state explicit, offline save takes effect after restart, service control opt-in')
    c.call('api/password','POST',{'current':'bad','password':'new-long-test-password-1'},400)
    c.call('api/password','POST',{'current':password,'password':'short'},400)
    c.call('api/password','POST',{'current':password,'password':'new-long-test-password-1'})
    c.call('api/me',expected=401)
    c.call('api/login','POST',{'username':username,'password':password},401)
    c.login(username,'new-long-test-password-1')
    events,_=c.call('api/audit');assert any(e['kind']=='backup_restored' for e in events)
    assert password not in json.dumps(events) and 'new-long-test-password-1' not in json.dumps(events)
    ok('password rotation invalidates all sessions; audit excludes passwords')
    stop(panel);panel=start(*args);wait_for(lambda:urllib.request.urlopen(base,timeout=1).status==200)
    c.call('api/me',expected=401);c.login(username,'new-long-test-password-1')
    assert len(c.call('api/backups')[0])==30
    assert len(c.call('api/audit')[0])>=len(events)
    ok('credentials, audit and backups persist; sessions expire on panel restart')
    c.call('api/logout','POST',{});c.call('api/me',expected=401)
    for _ in range(19):c.call('api/login','POST',{'username':username,'password':'wrong'},401)
    c.call('api/login','POST',{'username':username,'password':'wrong'},429)
    ok('logout revokes session and login attempts are rate-limited')
    echo.shutdown();echo.server_close()
finally:
    for p in reversed(PROCS):stop(p)
    (ROOT/'report.json').write_text(json.dumps({'passed':RESULT},ensure_ascii=False,indent=2))
    print('Test artifacts:',ROOT,flush=True)
