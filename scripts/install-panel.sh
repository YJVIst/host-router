#!/usr/bin/env bash
# Install a separately managed Rust panel; keep an existing forwarding process untouched.
set -Eeuo pipefail
umask 077
binary='' username='' secret='' port='' origin='' bind='' base_path='/'
config='/etc/host-router/config.json' data_dir='/var/lib/host-router-panel'
password_stdin=0
usage() {
  echo 'Usage: install-panel.sh --binary ./host-router [--username USER --password-stdin --port PORT] [--origin https://router.example.com] [--base-path /] [--config /etc/host-router/config.json] [--data-dir /var/lib/host-router-panel]'
}
die() { printf '安装失败：%s\n' "$*" >&2; exit 1; }
while (($#)); do
  case "$1" in
    --binary|--username|--port|--origin|--base-path|--config|--data-dir)
      (($#>=2)) || die '参数缺少值'
      case "$1" in
        --binary) binary="$2";; --username) username="$2";; --port) port="$2";;
        --origin) origin="$2";; --base-path) base_path="$2";; --config) config="$2";; --data-dir) data_dir="$2";;
      esac; shift 2;;
    --password-stdin) password_stdin=1; shift;;
    --help|-h) usage; exit 0;;
    *) usage; die '未知参数';;
  esac
done
[[ $EUID -eq 0 ]] || die '请以 root 运行'
[[ -f "$binary" && -x "$binary" ]] || die '需要通过 --binary 提供二进制'
"$binary" panel-account --help >/dev/null || die '需要支持面板账户配置的新版程序'
if [[ "$password_stdin" == 1 ]]; then
  IFS= read -r secret || [[ -n "$secret" ]] || die '未从 stdin 收到密码'
fi
if [[ -z "$username" || -z "$port" || "$password_stdin" == 0 ]]; then
  exec 3</dev/tty || die '无交互终端；请使用 --username --password-stdin --port'
  if [[ -z "$username" ]]; then
    printf '管理员用户名：' >&2; IFS= read -r -u 3 username || die '输入已结束'
  fi
  if [[ "$password_stdin" == 0 ]]; then
    printf '管理员密码（至少 14 位，不显示输入）：' >&2
    IFS= read -r -s -u 3 secret || die '输入已结束'; printf '\n' >&2
  fi
  if [[ -z "$port" ]]; then
    printf 'Web 访问端口 [18110]：' >&2; IFS= read -r -u 3 port || die '输入已结束'; port="${port:-18110}"
  fi
  exec 3<&-
fi
# Password travels through stdin only, never process arguments or a shell interpolation.
printf '%s\n' "$secret" | "$binary" panel-account --data-dir "$data_dir" --username "$username" --password-stdin --check-only
[[ "$port" =~ ^[0-9]+$ && ${#port} -le 5 ]] || die '端口必须为 1024–65535'
port=$((10#$port)); ((port>=1024 && port<=65535)) || die '端口必须为 1024–65535'
[[ "$base_path" =~ ^/([A-Za-z0-9_-]+/)*$ ]] || die '路径应为 / 或 /console/'
[[ "$config" =~ ^/[A-Za-z0-9_./-]+$ && "$data_dir" =~ ^/[A-Za-z0-9_./-]+$ ]] || die '请使用不含空格的绝对路径'
export PATH="$PATH:/usr/sbin:/sbin"
command -v systemctl >/dev/null || die '需要采用 systemd 的 Linux'
missing=0
for tool in runuser useradd install visudo sudo curl ss flock; do command -v "$tool" >/dev/null || missing=1; done
if [[ "$missing" == 1 ]]; then
  printf '正在安装面板所需的系统工具。\n'
  if command -v apt-get >/dev/null; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates sudo util-linux passwd iproute2
  elif command -v dnf >/dev/null; then dnf install -y curl ca-certificates sudo util-linux shadow-utils iproute
  elif command -v yum >/dev/null; then yum install -y curl ca-certificates sudo util-linux shadow-utils iproute
  else die '请先安装 curl、CA 证书、sudo、util-linux、useradd 和 iproute2'; fi
fi
for tool in runuser useradd install visudo sudo curl ss flock; do command -v "$tool" >/dev/null || die "缺少依赖 $tool"; done
[[ -x /usr/bin/systemctl && -x /usr/bin/sudo ]] || die 'systemctl 和 sudo 必须位于 /usr/bin'
if [[ -z "$origin" ]]; then
  # Only public IP discovery; no credentials are sent. Explicit --origin skips discovery.
  detected_ip="$(curl --proto '=https' --tlsv1.2 -fsS --connect-timeout 3 --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  if [[ ! "$detected_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    detected_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1);exit}}')"
  fi
  [[ "$detected_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die '未能自动确定访问 IP；可使用 --origin http://实际IP:端口'
  origin="http://$detected_ip:$port"
fi
[[ "$origin" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die '--origin 应为 http(s)://域名或IP[:端口]，不含路径'
public_args=()
if [[ "$origin" == https://* ]]; then bind="127.0.0.1:$port"
else
  [[ "$origin" == *":$port" ]] || die 'HTTP origin 的端口应与访问端口一致'
  bind="0.0.0.0:$port"; public_args=(--allow-public-http)
fi
[[ ! -L /run/host-router-panel-install ]] || die '安装锁目录不能是符号链接'
install -d -m 0700 /run/host-router-panel-install
exec 9>/run/host-router-panel-install/lock
flock -n 9 || die '已有面板安装任务'
for path in /usr/local/lib/host-router-panel /var/lib/host-router-panel /etc/systemd/system/host-router-panel.service /etc/sudoers.d/host-router-panel "$data_dir" "$config"; do
  [[ ! -L "$path" ]] || die "安装路径不能是符号链接：$path"
done
existing_pid="$(systemctl show host-router-panel.service -p MainPID --value 2>/dev/null || true)"
listeners="$(ss -H -lntp "sport = :$port")"
if [[ -n "$listeners" ]]; then
  [[ "$existing_pid" =~ ^[1-9][0-9]*$ ]] || die '访问端口已被其他程序占用'
  while IFS= read -r line; do
    [[ "$line" == *"pid=$existing_pid,"* ]] || die '访问端口已被其他程序占用'
  done <<< "$listeners"
fi
# A configured forwarding port may currently be stopped; reserve it for the core.
if [[ -e "$config" ]]; then
  "$binary" -c "$config" check >/dev/null
  if "$binary" -c "$config" list | awk -v p="$port" 'NR>1 {v=$2;sub(/^.*:/,"",v);if(v+0==p)found=1} END {exit !found}'; then die '该端口已被转发规则使用，请选择其他 Web 端口'; fi
fi
id hostrouter >/dev/null 2>&1 || useradd --system --user-group --no-create-home --shell /usr/sbin/nologin hostrouter
prepare_dir() {
  local path="$1"
  [[ ! -L "$path" ]] || die "目录不能是符号链接：$path"
  if [[ -e "$path" ]]; then [[ -d "$path" && "$(stat -c %U "$path")" == hostrouter ]] || die "已有目录需属于 hostrouter：$path"
  else install -d -m 0700 -o hostrouter -g hostrouter "$path"; fi
}
config_dir="$(dirname -- "$config")"
new_core=0
if systemctl cat host-router.service >/dev/null 2>&1; then
  [[ -f "$config" && "$(stat -c %U "$config")" == hostrouter ]] || die '已有内核配置不存在或不属于 hostrouter，请先检查配置路径'
  [[ "$(systemctl show host-router.service -p User --value)" == hostrouter ]] || die '已有内核服务用户不同，请手动接入，避免修改生产服务'
else
  new_core=1
  if [[ ! -e "$config" ]]; then prepare_dir "$config_dir"; "$binary" -c "$config" init; "$binary" -c "$config" prepare-config --user hostrouter
  else [[ "$(stat -c %U "$config")" == hostrouter ]] || die '已有配置需属于 hostrouter'; fi
fi
prepare_dir "$data_dir"
recovery="/var/backups/host-router-panel/$(date -u +%Y%m%dT%H%M%SZ)-$$"
install -d -m 0700 "$recovery"
panel_bin=/usr/local/lib/host-router-panel/host-router
panel_unit=/etc/systemd/system/host-router-panel.service
sudo_file=/etc/sudoers.d/host-router-panel
old_running=0; old_enabled=0
if systemctl is-active --quiet host-router-panel.service; then old_running=1; fi
if systemctl is-enabled --quiet host-router-panel.service; then old_enabled=1; fi
for pair in "$panel_bin:binary" "$panel_unit:unit" "$sudo_file:sudoers" "$data_dir/admin.json:admin.json" "$data_dir/管理员登录信息.txt:credentials.txt" "$data_dir/access.txt:access.txt"; do
  source_file="${pair%:*}"; name="${pair##*:}"
  if [[ -f "$source_file" ]]; then cp -p -- "$source_file" "$recovery/$name"; fi
 done
changed=0
# Invoked by ERR trap; restore the panel only, never stop the forwarding service.
# shellcheck disable=SC2317
rollback() {
  local code=$?
  trap - ERR
  if [[ "$changed" == 1 ]]; then
    systemctl stop host-router-panel.service >/dev/null 2>&1 || true
    for pair in "$panel_bin:binary" "$panel_unit:unit" "$sudo_file:sudoers" "$data_dir/admin.json:admin.json" "$data_dir/管理员登录信息.txt:credentials.txt" "$data_dir/access.txt:access.txt"; do
      destination="${pair%:*}"; name="${pair##*:}"
      if [[ -f "$recovery/$name" ]]; then cp -p -- "$recovery/$name" "$destination"; else rm -f -- "$destination"; fi
    done
    systemctl daemon-reload
    if [[ "$old_enabled" == 1 ]]; then systemctl enable host-router-panel.service >/dev/null 2>&1 || true
    else systemctl disable host-router-panel.service >/dev/null 2>&1 || true; fi
    if [[ "$old_running" == 1 ]]; then systemctl start host-router-panel.service || true; fi
    printf '面板安装失败，已尝试恢复原面板。备份：%s\n' "$recovery" >&2
  fi
  exit "$code"
}
trap rollback ERR
install -d -m 0755 /usr/local/lib/host-router-panel
stage="$(mktemp /usr/local/lib/host-router-panel/.host-router.XXXXXX)"
trap 'rm -f -- "${stage:-}"; unset secret' EXIT
install -m 0755 "$binary" "$stage"
changed=1
if [[ "$old_running" == 1 ]]; then systemctl stop host-router-panel.service; fi
mv -f -- "$stage" "$panel_bin"
printf '%s\n' "$secret" | runuser -u hostrouter -- "$panel_bin" panel-account --data-dir "$data_dir" --username "$username" --password-stdin
unset secret
if [[ "$new_core" == 1 ]]; then
  if [[ ! -e /usr/local/bin/host-router ]]; then install -m 0755 "$panel_bin" /usr/local/bin/host-router; fi
  cat > /etc/systemd/system/host-router.service <<UNIT
[Unit]
Description=Host Router forwarding core
After=network.target
[Service]
User=hostrouter
Group=hostrouter
ExecStart=/usr/local/bin/host-router -c $config serve
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$config_dir
[Install]
WantedBy=multi-user.target
UNIT
  chmod 0644 /etc/systemd/system/host-router.service
fi
cat > "$recovery/new.sudoers" <<'SUDO'
Defaults:hostrouter !requiretty
hostrouter ALL=(root) NOPASSWD: /usr/bin/systemctl start host-router.service, /usr/bin/systemctl stop host-router.service, /usr/bin/systemctl restart host-router.service
SUDO
visudo -cf "$recovery/new.sudoers" >/dev/null
install -m 0440 "$recovery/new.sudoers" "$sudo_file"
cat > "$panel_unit" <<UNIT
[Unit]
Description=Host Router administration panel
After=network.target host-router.service
[Service]
User=hostrouter
Group=hostrouter
ExecStart=$panel_bin -c $config panel --data-dir $data_dir --listen $bind --origin $origin --base-path $base_path ${public_args[*]} --manage-service
Restart=on-failure
RestartSec=3
UMask=0077
CPUWeight=20
MemoryMax=128M
TasksMax=64
LimitNOFILE=4096
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$config_dir $data_dir
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "$panel_unit"
printf '面板地址：%s%s\n管理员登录信息：%s/管理员登录信息.txt\n' "$origin" "$base_path" "$data_dir" > "$data_dir/access.txt"
chmod 0600 "$data_dir/access.txt"
systemctl daemon-reload
if [[ "$new_core" == 1 ]]; then systemctl enable --now host-router.service; fi
systemctl enable host-router-panel.service
systemctl restart host-router-panel.service
ready=0
for ((attempt=0;attempt<30;attempt++)); do
  if curl --fail --silent --max-time 2 "http://127.0.0.1:$port$base_path" -o /dev/null; then ready=1; break; fi
  sleep 1
done
((ready==1))
systemctl is-active --quiet host-router-panel.service
changed=0
printf '\n面板安装完成：%s%s\n管理员账号：%s\n登录信息已保存：%s/管理员登录信息.txt\n面板备份：%s\n' "$origin" "$base_path" "$username" "$data_dir" "$recovery"
if [[ "$origin" == http://* ]]; then printf '当前为 Rust HTTP 直连；如服务器有安全组，请放行 TCP %s。HTTPS 反向代理可按文档自行配置。\n' "$port"
else printf '面板仅监听回环地址，请自行配置 HTTPS 反向代理。\n'; fi
