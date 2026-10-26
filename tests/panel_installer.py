#!/usr/bin/env python3
"""Real installer, files, prompts and Rust processes in private mount/PID namespaces.
Only systemctl is simulated. No host services, units or account files are changed.
"""
import os,sys,pathlib,subprocess,tempfile,json,time,socket,urllib.request,http.cookiejar,pty,select,signal,hashlib,termios,shutil
ROOT=pathlib.Path(__file__).resolve().parents[1]
BIN=pathlib.Path(sys.argv[1]).resolve()
if '--child' not in sys.argv:
    assert os.geteuid()==0,'Run with sudo (private filesystem namespaces required)'
    for tool in ['unshare','mount','systemctl','runuser','useradd','visudo','sudo','curl','ss','flock']:
        assert shutil.which(tool,path=os.environ.get('PATH','')+':/usr/sbin:/sbin'),f'Install test prerequisite before running: {tool}'
    workspace=pathlib.Path(tempfile.mkdtemp(prefix='host-router-installer-'));workspace.chmod(0o755)
    p=subprocess.run(['unshare','--mount','--pid','--fork','--mount-proc',sys.executable,__file__,str(BIN),'--child',str(workspace)])
    print('Installer test artifacts:',workspace)
    raise SystemExit(p.returncode)
work=pathlib.Path(sys.argv[-1]);os.umask(0o077)
subprocess.run(['mount','--make-rprivate','/'],check=True)
for i,dest in enumerate(['/etc','/usr/local','/var']):
    base=work/f'overlay-{i}';(base/'upper').mkdir(parents=True);(base/'work').mkdir();(base/'upper').chmod(pathlib.Path(dest).stat().st_mode & 0o777)
    subprocess.run(['mount','-t','overlay','overlay','-o',f'lowerdir={dest},upperdir={base}/upper,workdir={base}/work',dest],check=True)
subprocess.run(['mount','-t','tmpfs','tmpfs','/run'],check=True)
# Hide any real host installation in the private overlay.
for p in ['/etc/host-router','/var/lib/host-router-panel','/usr/local/lib/host-router-panel']:
    if pathlib.Path(p).exists():shutil.rmtree(p)
for p in ['/usr/local/bin/host-router','/etc/systemd/system/host-router.service','/etc/systemd/system/host-router-panel.service','/etc/sudoers.d/host-router-panel']:
    pathlib.Path(p).unlink(missing_ok=True)
stubs=work/'stubs';stubs.mkdir();stubs.chmod(0o755)
mock=stubs/'systemctl'
mock.write_text('''#!/usr/bin/python3
import sys,os,json,pathlib,subprocess,signal,time,shlex,pwd
root=pathlib.Path(os.environ['HR_INSTALL_TEST']);path=root/'units.json'
s=json.loads(path.read_text()) if path.exists() else {}
a=sys.argv[1:];cmd=a[0];args=[x for x in a[1:] if not x.startswith('-')];u=next((x for x in args if x.endswith('.service')),'')
with (root/'systemctl.log').open('a') as f:f.write(' '.join(a)+'\\n')
def live(u):
 p=s.get(u,{}).get('pid',0)
 try:return p>0 and pathlib.Path('/proc/'+str(p)+'/stat').read_text().split()[2]!='Z'
 except FileNotFoundError:return False
def save():path.write_text(json.dumps(s))
def stop(u):
 if live(u):
  os.kill(s[u]['pid'],signal.SIGTERM)
  for _ in range(100):
   if not live(u):break
   time.sleep(.03)
def start(u):
 if live(u):return
 marker=root/'fail-next-panel'
 if u=='host-router-panel.service' and marker.exists():marker.unlink();sys.exit(1)
 text=pathlib.Path('/etc/systemd/system/'+u).read_text();line=next(x[10:] for x in text.splitlines() if x.startswith('ExecStart='));user=pwd.getpwnam('hostrouter')
 log=open(root/(u+'.log'),'ab');p=subprocess.Popen(shlex.split(line),stdin=subprocess.DEVNULL,stdout=log,stderr=log,user=user.pw_uid,group=user.pw_gid,start_new_session=True,cwd='/')
 s.setdefault(u,{})['pid']=p.pid;save();time.sleep(.15)
if cmd=='cat':
 p=pathlib.Path('/etc/systemd/system/'+u)
 if not p.exists():sys.exit(1)
 print(p.read_text())
elif cmd=='show':
 prop=a[a.index('-p')+1]
 print(str(s.get(u,{}).get('pid',0)) if prop=='MainPID' else 'hostrouter' if prop=='User' else '')
elif cmd=='is-active':sys.exit(0 if live(u) else 3)
elif cmd=='is-enabled':sys.exit(0 if s.get(u,{}).get('enabled') else 1)
elif cmd=='enable':
 s.setdefault(u,{})['enabled']=True;save()
 if '--now' in a:start(u)
elif cmd=='disable':
 s.setdefault(u,{})['enabled']=False;save()
 if '--now' in a:stop(u)
elif cmd=='start':start(u)
elif cmd=='stop':stop(u)
elif cmd=='restart':stop(u);start(u)
elif cmd=='daemon-reload':pass
else:raise RuntimeError(a)
''');mock.chmod(0o755)
# Optional release fixture exercises the complete bootstrap -> menu -> installer hash chain.
if os.environ.get('HR_RELEASE_DIR'):
    curl=stubs/'curl'
    curl.write_text("#!/usr/bin/python3\nimport os,sys,pathlib,shutil\nargs=sys.argv[1:];url=next((x for x in args if x.startswith('https://github.com/YJVIst/host-router/releases/')),None)\nif url:\n source=pathlib.Path(os.environ['HR_RELEASE_DIR'])/url.rsplit('/',1)[1]\n if '-o' in args:shutil.copyfile(source,args[args.index('-o')+1])\n else:sys.stdout.buffer.write(source.read_bytes())\nelse:os.execv('/usr/bin/curl',['curl']+args)\n");curl.chmod(0o755)
env={**os.environ,'PATH':str(stubs)+':/usr/sbin:/usr/bin:/sbin:/bin','HR_INSTALL_TEST':str(work),'TMPDIR':str(work)}
def port():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
def account():return pathlib.Path('/var/lib/host-router-panel/admin.json').read_bytes()
def corepid():return json.loads((work/'units.json').read_text())['host-router.service']['pid']
def login(p,user,pw):
 jar=http.cookiejar.CookieJar();op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
 req=urllib.request.Request(f'http://127.0.0.1:{p}/api/login',data=json.dumps({'username':user,'password':pw}).encode(),headers={'Content-Type':'application/json','X-Requested-With':'host-router-panel'})
 with op.open(req,timeout=10) as r:assert r.status==200 and json.load(r)['username']==user
 return op
installer=ROOT/'scripts/install-panel.sh';secret="Installer-$'test-password";p=port();origin=f'http://127.0.0.1:{p}'
args=['bash',str(installer),'--binary',str(BIN),'--origin',origin]
# A controlling terminal, including hidden password and a process-substitution caller.
code=f'bash <(cat {str(installer)!r}) --binary {str(BIN)!r} --origin {origin!r}'
if os.environ.get('HR_RELEASE_DIR'):
 code=f'bash <(cat {str(ROOT/"install.sh")!r}) panel-install'
elif os.environ.get('HR_PUBLIC_INSTALL'):
 code='bash <(curl -fsSL https://raw.githubusercontent.com/YJVIst/host-router/main/install.sh) panel-install'
pid,fd=pty.fork()
if pid==0:os.execvpe('bash',['bash','-c',code],env)
transcript=b'';prompts=[('管理员用户名：','operator_1'),('管理员密码（至少 14 位，不显示输入）：',secret),('Web 访问端口 [18110]：',str(p))];index=0;deadline=time.monotonic()+240
while time.monotonic()<deadline:
 if select.select([fd],[],[],.1)[0]:
  try:chunk=os.read(fd,65536)
  except OSError:break
  if not chunk:break
  transcript+=chunk
  if index<len(prompts) and prompts[index][0].encode() in transcript:
   if index==1:
    for _ in range(100):
     if not termios.tcgetattr(fd)[3] & termios.ECHO:break
     time.sleep(.01)
    assert not termios.tcgetattr(fd)[3] & termios.ECHO
   os.write(fd,(prompts[index][1]+'\n').encode());index+=1
else:os.kill(pid,signal.SIGKILL);raise AssertionError('PTY install timeout')
_,status=os.waitpid(pid,0);os.close(fd);(work/'terminal.txt').write_bytes(transcript)
assert os.waitstatus_to_exitcode(status)==0,transcript.decode(errors='replace')[-3000:]
assert secret.encode() not in transcript and index==3
op=login(p,'operator_1',secret);print('PASS fresh install through process substitution; exactly three prompts; hidden password; HTTP login',flush=True)
cfg=pathlib.Path('/etc/host-router/config.json').read_bytes();oldpid=corepid();oldbinary=hashlib.sha256(pathlib.Path('/usr/local/bin/host-router').read_bytes()).hexdigest()
p2=port();args2=['bash',str(installer),'--binary',str(BIN),'--origin',f'http://127.0.0.1:{p2}','--username','operator_2','--password-stdin','--port',str(p2)]
r=subprocess.run(args2,input=secret+'\n',text=True,capture_output=True,env=env,timeout=60);assert r.returncode==0,r.stderr
login(p2,'operator_2',secret)
assert corepid()==oldpid and pathlib.Path('/etc/host-router/config.json').read_bytes()==cfg
assert hashlib.sha256(pathlib.Path('/usr/local/bin/host-router').read_bytes()).hexdigest()==oldbinary
unit=pathlib.Path('/etc/systemd/system/host-router-panel.service').read_text();assert f'0.0.0.0:{p2}' in unit and '--allow-public-http' in unit
assert '/mnt/' not in unit and '/var/lib/host-router-panel' in unit and '/etc/host-router/config.json' in unit
assert pathlib.Path('/var/lib/host-router-panel/管理员登录信息.txt').stat().st_mode&0o777==0o600
print('PASS reconfigure account and port; standard paths; existing core PID/binary/config preserved',flush=True)
oldaccount=account()
with socket.socket() as held:
 held.bind(('0.0.0.0',0));held.listen();occupied=held.getsockname()[1]
 args3=args2.copy();args3[args3.index('--port')+1]=str(occupied);args3[args3.index('--origin')+1]=f'http://127.0.0.1:{occupied}'
 r=subprocess.run(args3,input=secret+'\n',text=True,capture_output=True,env=env,timeout=30);assert r.returncode!=0 and '占用' in r.stderr
 assert oldaccount==account() and oldpid==corepid()
print('PASS occupied port rejected without account or core changes',flush=True)
(work/'fail-next-panel').touch()
r=subprocess.run(args2,input='Replacement-password-123\n',text=True,capture_output=True,env=env,timeout=60);assert r.returncode!=0
assert oldaccount==account() and oldpid==corepid();login(p2,'operator_2',secret)
print('PASS startup failure restores previous panel account and running panel; forwarding process untouched',flush=True)
# Bounded stdin and running-panel account lock.
r=subprocess.run([str(BIN),'panel-account','--username','operator_3','--password-stdin'],input=secret+'\n',text=True,capture_output=True);assert r.returncode!=0
assert account()==oldaccount
print('PASS live panel account cannot be overwritten by offline CLI',flush=True)
(work/'result.json').write_text(json.dumps({'fresh_install':True,'three_prompts':True,'password_not_echoed':True,'default_direct_http':True,'standard_paths':True,'reconfigure_preserves_core':True,'occupied_port':True,'rollback':True,'running_account_lock':True},indent=2))
for u in ['host-router-panel.service','host-router.service']:subprocess.run([str(mock),'stop',u],env=env,check=True)
