#!/usr/bin/env python3
"""Run inside a fresh network namespace. No workload touches host networking."""
import argparse,json,os,pathlib,pwd,resource,subprocess,threading,time
p=argparse.ArgumentParser()
p.add_argument("binary");p.add_argument("output")
p.add_argument("--driver",required=True)
p.add_argument("--user",default="nobody")
p.add_argument("--idle",type=int,default=2000);p.add_argument("--bulk",type=int,default=16)
p.add_argument("--seconds",type=int,default=12);p.add_argument("--rate",type=int,default=100)
p.add_argument("--mbps",type=int,default=0)
a=p.parse_args()
if os.geteuid()!=0:
 p.error("run with sudo unshare --net --mount --propagation private")
if os.readlink("/proc/self/ns/net")==os.readlink("/proc/1/ns/net"):
 p.error("a private network namespace is required")
cpus=sorted(os.sched_getaffinity(0))
if len(cpus)<3:
 p.error("at least three available CPUs are needed to separate traffic from the router")
if not (0<=a.idle<=3500 and 0<=a.bulk<=64 and 1<=a.seconds<=300 and 1<=a.rate<=500 and 0<=a.mbps<=100000):
 p.error("bounded workload required: idle 0..3500, bulk 0..64, seconds 1..300, rate 1..500")
account=pwd.getpwnam(a.user)
if account.pw_uid==0:
 p.error("router must run as an unprivileged account")
a.binary=str(pathlib.Path(a.binary).resolve())
a.driver=str(pathlib.Path(a.driver).resolve())
subprocess.run(["ip","link","set","lo","up"],check=True)
resource.setrlimit(resource.RLIMIT_NOFILE,(65536,65536))
root=pathlib.Path(a.output).resolve();root.mkdir(parents=True,exist_ok=False)
os.chown(root,account.pw_uid,account.pw_gid);os.chmod(root,0o750)
driver=a.driver
cfg=dict(access_log=False,auto_capacity=False,max_tcp_connections=16384,max_connections_per_ip=4096,
 max_pending_handshakes=1024,rules=[
  dict(listen="127.0.0.1:29790",domain="bulk.bench.test",target="127.0.0.1:29791",protocol="tcp"),
  dict(listen="127.0.0.1:29790",domain="tls.bench.test",target="127.0.0.1:29792",protocol="tcp")])
path=root/"config.json";path.write_text(json.dumps(cfg));os.chown(path,account.pw_uid,account.pw_gid);os.chmod(path,0o600)
env=dict(os.environ,GOMAXPROCS="2")
backend=None;router=None;traffic=None;stop=threading.Event();samples=[]
def metric(pid):
 try:
  st=pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(")",1)[1].split()
  rss=[int(l.split()[1]) for l in pathlib.Path(f"/proc/{pid}/status").read_text().splitlines() if l.startswith("VmRSS:")][0]
  return dict(cpu=(int(st[11])+int(st[12]))/os.sysconf("SC_CLK_TCK"),rss=rss,fds=len(os.listdir(f"/proc/{pid}/fd")))
 except (FileNotFoundError,IndexError):return {}
def child_pid(pid):
 for _ in range(100):
  ch=pathlib.Path(f"/proc/{pid}/task/{pid}/children").read_text().split()
  if ch:return int(ch[0])
  time.sleep(.02)
 raise RuntimeError("router child not running")
try:
 backend=subprocess.Popen(["taskset","-c",",".join(map(str,cpus[1:3])),driver,"backend",str(root)],stdout=subprocess.PIPE,stderr=(root/"backend.log").open("w"),text=True,env=env)
 assert backend.stdout.readline().strip()=="ready","backend startup"
 router=subprocess.Popen(["runuser","-u",a.user,"--","prlimit","--nofile=65536:65536","--","taskset","-c",str(cpus[0]),a.binary,"-c",str(path),"serve"],stdout=(root/"router.log").open("w"),stderr=subprocess.STDOUT)
 pid=child_pid(router.pid)
 for _ in range(200):
  if path.with_suffix(".sock").exists():break
  assert router.poll() is None,(root/"router.log").read_text()
  time.sleep(.02)
 assert path.with_suffix(".sock").exists(),(root/"router.log").read_text()
 before=metric(pid);start=time.monotonic()
 def observe():
  while not stop.wait(.1):samples.append(metric(pid))
 t=threading.Thread(target=observe);t.start()
 traffic=subprocess.Popen(["taskset","-c",",".join(map(str,cpus[1:])),driver,"load","127.0.0.1:29790",str(root),str(a.idle),str(a.bulk),str(a.seconds),str(a.rate),str(a.mbps)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
 stdout,stderr=traffic.communicate(timeout=a.seconds+90)
 after=metric(pid);elapsed=time.monotonic()-start;stop.set();t.join()
 if not stdout.strip():raise RuntimeError(stderr or "traffic driver returned no results")
 out=json.loads(stdout)
 out.update(binary=a.binary,returncode=traffic.returncode,router_cpu_percent=100*(after["cpu"]-before["cpu"])/elapsed,
  router_peak_rss_kib=max(s.get("rss",0) for s in samples),router_peak_fds=max(s.get("fds",0) for s in samples),
  router_affinity="one CPU",system_cpus=os.cpu_count())
 for _ in range(100):
  state=json.loads(subprocess.check_output([a.binary,"-c",str(path),"status"],text=True))
  if state["tcp_active"]==state["pending_handshakes"]==state["tracked_ips"]==0:break
  time.sleep(.05)
 else:raise AssertionError("connection resources not reclaimed: "+json.dumps(state))
 out["router_status"]=state
 (root/"results.json").write_text(json.dumps(out,indent=2))
 print(json.dumps({k:v for k,v in out.items() if k!="router_status"}),flush=True)
 if traffic.returncode: print(stderr);raise SystemExit(traffic.returncode)
finally:
 stop.set()
 if traffic and traffic.poll() is None:traffic.terminate();traffic.wait(5)
 if router:
  # signal the router itself so runuser does not delay cleanup.
  try:os.kill(pid,15)
  except (ProcessLookupError,UnboundLocalError):pass
  try:router.wait(5)
  except subprocess.TimeoutExpired:router.kill();router.wait()
 if backend:backend.terminate();backend.wait(5)

