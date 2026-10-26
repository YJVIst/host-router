//! Independent HTTP control plane. Forwarding remains in the existing core process.
use crate::{
    config::{Config, MAX_CONFIG},
    control,
};
use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use ring::{
    digest, pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    net::SocketAddr,
    num::NonZeroU32,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

#[derive(clap::Args, Clone)]
pub struct Options {
    #[arg(long, default_value = "127.0.0.1:18110")]
    listen: SocketAddr,
    #[arg(long, default_value = "/var/lib/host-router-panel")]
    data_dir: PathBuf,
    /// Exact browser origin, e.g. https://router.example.com
    #[arg(long, default_value = "http://127.0.0.1:18110")]
    origin: String,
    #[arg(long, default_value = "/")]
    base_path: String,
    /// Explicitly permit direct HTTP on a non-loopback address.
    #[arg(long)]
    allow_public_http: bool,
    /// Enable fixed host-router.service systemd actions through sudo.
    #[arg(long)]
    manage_service: bool,
}
#[derive(Clone, Serialize, Deserialize)]
struct Admin {
    username: String,
    salt: Vec<u8>,
    hash: Vec<u8>,
}
#[derive(Clone)]
struct Session {
    csrf: String,
    expires: Instant,
}
struct Auth {
    admin: Admin,
    sessions: HashMap<String, Session>,
    attempts: Vec<Instant>,
}
#[derive(Serialize, Deserialize, Default)]
struct History {
    events: Vec<Value>,
}
struct App {
    config: PathBuf,
    opts: Options,
    auth: Mutex<Auth>,
    writes: Mutex<()>,
    history: Mutex<History>,
}
type Shared = Arc<App>;
struct Error(StatusCode, String);
type Api<T> = std::result::Result<T, Error>;
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}
impl From<anyhow::Error> for Error {
    fn from(e: anyhow::Error) -> Self {
        Self(StatusCode::BAD_REQUEST, format!("{e:#}"))
    }
}
fn fail(code: StatusCode, text: impl Into<String>) -> Error {
    Error(code, text.into())
}
fn epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn random(n: usize) -> Result<Vec<u8>> {
    let mut b = vec![0; n];
    SystemRandom::new()
        .fill(&mut b)
        .map_err(|_| anyhow::anyhow!("random source unavailable"))?;
    Ok(b)
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|v| format!("{v:02x}")).collect()
}
fn token() -> Result<String> {
    Ok(hex(&random(32)?))
}
fn revision(c: &Config) -> String {
    hex(digest::digest(&digest::SHA256, &serde_json::to_vec(c).unwrap()).as_ref())
}
fn password(admin: &mut Admin, secret: &str) -> Result<()> {
    ensure!(
        (14..=256).contains(&secret.len()),
        "密码长度必须为 14–256 字节"
    );
    admin.salt = random(32)?;
    admin.hash = vec![0; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(600_000).unwrap(),
        &admin.salt,
        secret.as_bytes(),
        &mut admin.hash,
    );
    Ok(())
}
fn verify(admin: &Admin, secret: &str) -> bool {
    pbkdf2::verify(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(600_000).unwrap(),
        &admin.salt,
        secret.as_bytes(),
        &admin.hash,
    )
    .is_ok()
}
fn write_private(path: &FsPath, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension(format!("{}.tmp", hex(&random(8)?)));
    let result = (|| -> Result<()> {
        let mut f = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&tmp, path)?;
        fs::File::open(path.parent().context("missing parent")?)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}
pub fn set_account(dir: &FsPath, username: String, secret: &str, check_only: bool) -> Result<()> {
    ensure!(
        (3..=64).contains(&username.len())
            && username
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c)),
        "管理员用户名需要 3–64 个字母、数字、下划线、点或连字符"
    );
    ensure!(
        (14..=256).contains(&secret.len()) && !secret.chars().any(|c| c.is_control()),
        "密码需要 14–256 字节且不能包含换行或控制字符"
    );
    if check_only {
        return Ok(());
    }
    fs::create_dir_all(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    let _running = control::lock(&dir.join("panel.json")).context("请先停止管理面板再修改账号")?;
    let _account = control::lock(&dir.join("admin.json"))?;
    let mut admin = Admin {
        username,
        salt: vec![],
        hash: vec![],
    };
    password(&mut admin, secret)?;
    write_private(&dir.join("管理员登录信息.txt"), format!("Host Router 管理面板\n管理员账号：{}\n初始密码：{}\n登录后可在系统设置修改密码；此文件记录安装时密码。\n", admin.username, secret).as_bytes())?;
    write_private(&dir.join("admin.json"), &serde_json::to_vec_pretty(&admin)?)?;
    println!(
        "Panel account saved. Credentials: {}",
        dir.join("管理员登录信息.txt").display()
    );
    Ok(())
}

pub fn initialize(dir: &FsPath) -> Result<()> {
    fs::create_dir_all(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    let path = dir.join("admin.json");
    if path.exists() {
        println!("Panel account already exists; credentials preserved.");
        return Ok(());
    }
    let _guard = control::lock(&path)?;
    ensure!(
        !path.exists(),
        "panel account initialized concurrently; retry"
    );
    let secret = hex(&random(18)?);
    let mut admin = Admin {
        username: format!("admin_{}", hex(&random(3)?)),
        salt: vec![],
        hash: vec![],
    };
    password(&mut admin, &secret)?;
    // Store bootstrap credentials before the account: interrupted initialization can safely retry.
    write_private(&dir.join("管理员登录信息.txt"),format!("Host Router 管理面板\n管理员账号：{}\n初始密码：{}\n登录后可在系统设置中修改密码；此文件只记录初始密码。\n",admin.username,secret).as_bytes())?;
    write_private(&path, &serde_json::to_vec_pretty(&admin)?)?;
    println!(
        "Initial credentials saved to {}",
        dir.join("管理员登录信息.txt").display()
    );
    Ok(())
}
fn cookie_id(h: &HeaderMap) -> Option<&str> {
    h.get("cookie")?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|s| s.trim().strip_prefix("hr_session="))
}
async fn auth(s: &Shared, h: &HeaderMap, write: bool) -> Api<Session> {
    let mut a = s.auth.lock().await;
    a.sessions.retain(|_, v| v.expires > Instant::now());
    let v = cookie_id(h)
        .and_then(|id| a.sessions.get(id))
        .cloned()
        .ok_or_else(|| fail(StatusCode::UNAUTHORIZED, "登录已过期，请重新登录"))?;
    if write && h.get("x-csrf-token").and_then(|v| v.to_str().ok()) != Some(v.csrf.as_str()) {
        return Err(fail(StatusCode::FORBIDDEN, "请求验证失败，请刷新页面"));
    }
    Ok(v)
}
fn cookie(s: &App, id: &str, age: u32) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "hr_session={id}; Path={}; HttpOnly; SameSite=Strict; Max-Age={age}{}",
        s.opts.base_path,
        if s.opts.origin.starts_with("https://") {
            "; Secure"
        } else {
            ""
        }
    ))
    .unwrap()
}
async fn guard(State(s): State<Shared>, req: axum::extract::Request, next: Next) -> Response {
    if req.method() != Method::GET && req.method() != Method::HEAD {
        let h = req.headers();
        if h.get("x-requested-with").and_then(|v| v.to_str().ok()) != Some("host-router-panel")
            || h.get("origin")
                .is_some_and(|v| v.to_str().ok() != Some(s.opts.origin.as_str()))
        {
            return fail(StatusCode::FORBIDDEN, "跨站请求已拒绝").into_response();
        }
    }
    // Authenticate before body extraction/validation, including malformed JSON requests.
    let path = req.uri().path();
    if path.starts_with("/api/") && path != "/api/login" {
        let write = req.method() != Method::GET && req.method() != Method::HEAD;
        if let Err(e) = auth(&s, req.headers(), write).await {
            return e.into_response();
        }
    }
    let mut res = next.run(req).await;
    for (k, v) in [
        ("cache-control", "no-store"),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("x-frame-options", "DENY"),
        (
            "content-security-policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        ),
    ] {
        res.headers_mut().insert(k, HeaderValue::from_static(v));
    }
    res
}
async fn event(s: &Shared, kind: &str, detail: &str) {
    let mut h = s.history.lock().await;
    h.events
        .push(json!({"time":epoch(),"kind":kind,"detail":detail}));
    if h.events.len() > 500 {
        let count = h.events.len() - 500;
        h.events.drain(..count);
    }
    if let Err(e) = write_private(
        &s.opts.data_dir.join("audit.json"),
        &serde_json::to_vec(&*h).unwrap(),
    ) {
        tracing::error!(error=%e,"panel audit persistence failed");
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Login {
    username: String,
    password: String,
}
async fn login(State(s): State<Shared>, Json(input): Json<Login>) -> Api<Response> {
    if input.password.len() > 256 || input.username.len() > 128 {
        return Err(fail(StatusCode::UNAUTHORIZED, "账号或密码错误"));
    }
    // Serialize expensive password verification and enforce a global bounded budget, also behind proxies.
    let mut a = s.auth.lock().await;
    a.attempts.retain(|t| t.elapsed() < Duration::from_secs(60));
    if a.attempts.len() >= 20 {
        return Err(fail(
            StatusCode::TOO_MANY_REQUESTS,
            "登录尝试过多，请一分钟后重试",
        ));
    }
    a.attempts.push(Instant::now());
    let admin = a.admin.clone();
    let secret = input.password;
    let correct = tokio::task::spawn_blocking(move || verify(&admin, &secret))
        .await
        .map_err(|_| fail(StatusCode::INTERNAL_SERVER_ERROR, "验证失败"))?;
    if !correct || input.username != a.admin.username {
        drop(a);
        event(&s, "login_failed", "账号或密码不匹配").await;
        return Err(fail(StatusCode::UNAUTHORIZED, "账号或密码错误"));
    }
    a.sessions.retain(|_, v| v.expires > Instant::now());
    if a.sessions.len() >= 32 {
        a.sessions.clear();
    }
    let id = token()?;
    let csrf = token()?;
    a.sessions.insert(
        id.clone(),
        Session {
            csrf: csrf.clone(),
            expires: Instant::now() + Duration::from_secs(28800),
        },
    );
    let name = a.admin.username.clone();
    drop(a);
    event(&s, "login", "管理员登录").await;
    let mut res = Json(json!({"username":name,"csrf":csrf})).into_response();
    res.headers_mut()
        .insert("set-cookie", cookie(&s, &id, 28800));
    Ok(res)
}
async fn me(State(s): State<Shared>, h: HeaderMap) -> Api<Json<Value>> {
    let session = auth(&s, &h, false).await?;
    Ok(Json(
        json!({"username":s.auth.lock().await.admin.username,"csrf":session.csrf,"manage_service":s.opts.manage_service,"version":env!("CARGO_PKG_VERSION")}),
    ))
}
async fn logout(State(s): State<Shared>, h: HeaderMap) -> Api<Response> {
    auth(&s, &h, true).await?;
    if let Some(id) = cookie_id(&h) {
        s.auth.lock().await.sessions.remove(id);
    }
    event(&s, "logout", "管理员退出").await;
    let mut res = Json(json!({"ok":true})).into_response();
    res.headers_mut().insert("set-cookie", cookie(&s, "", 0));
    Ok(res)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChangePassword {
    current: String,
    password: String,
}
async fn change_password(
    State(s): State<Shared>,
    h: HeaderMap,
    Json(input): Json<ChangePassword>,
) -> Api<Json<Value>> {
    auth(&s, &h, true).await?;
    if input.current.len() > 256 || !(14..=256).contains(&input.password.len()) {
        return Err(fail(StatusCode::BAD_REQUEST, "新密码需要 14–256 字节"));
    }
    let mut a = s.auth.lock().await;
    let mut admin = a.admin.clone();
    let admin = tokio::task::spawn_blocking(move || -> Result<Admin> {
        ensure!(verify(&admin, &input.current), "当前密码错误");
        password(&mut admin, &input.password)?;
        Ok(admin)
    })
    .await
    .map_err(|_| fail(StatusCode::INTERNAL_SERVER_ERROR, "验证失败"))??;
    write_private(
        &s.opts.data_dir.join("admin.json"),
        &serde_json::to_vec(&admin).map_err(anyhow::Error::from)?,
    )?;
    a.admin = admin;
    a.sessions.clear();
    drop(a);
    event(&s, "password_changed", "密码已修改，全部会话已失效").await;
    Ok(Json(json!({"ok":true})))
}
async fn live(s: &Shared) -> Result<Value> {
    let r = control::request(
        &s.config,
        control::Request {
            action: "status".into(),
            config: None,
            base: None,
        },
    )
    .await?;
    ensure!(r.ok, "{}", r.message);
    r.data.context("missing status")
}
async fn status(State(s): State<Shared>, h: HeaderMap) -> Api<Json<Value>> {
    auth(&s, &h, false).await?;
    Ok(Json(match live(&s).await {
        Ok(v) => json!({"running":true,"core":v}),
        Err(_) => {
            json!({"running":false,"error":"无法连接转发内核，请检查服务是否启动以及控制套接字权限"})
        }
    }))
}
async fn config(State(s): State<Shared>, h: HeaderMap) -> Api<Json<Value>> {
    auth(&s, &h, false).await?;
    let cfg = crate::read_cfg(&s.config)?;
    Ok(Json(json!({"config":cfg,"revision":revision(&cfg)})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Apply {
    config: Config,
    revision: String,
    #[serde(default)]
    offline: bool,
}
async fn validate(
    State(s): State<Shared>,
    h: HeaderMap,
    Json(cfg): Json<Config>,
) -> Api<Json<Value>> {
    auth(&s, &h, true).await?;
    let tables = cfg.tables()?;
    Ok(Json(
        json!({"valid":true,"rules":cfg.rules.len(),"listeners":tables.len()}),
    ))
}
fn snapshots(s: &App) -> Result<Vec<PathBuf>> {
    let mut files = fs::read_dir(s.opts.data_dir.join("backups"))?
        .filter_map(|e| e.ok().map(|v| v.path()))
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect::<Vec<_>>();
    files.sort();
    files.reverse();
    Ok(files)
}
fn backup(s: &App, cfg: &Config) -> Result<String> {
    let id = format!(
        "{}-{:09}-{}",
        epoch(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos(),
        hex(&random(6)?)
    );
    write_private(
        &s.opts.data_dir.join("backups").join(format!("{id}.json")),
        &serde_json::to_vec_pretty(cfg)?,
    )?;
    for p in snapshots(s)?.into_iter().skip(30) {
        fs::remove_file(p)?;
    }
    Ok(id)
}
async fn apply_inner(s: &Shared, input: Apply, reason: &str) -> Api<Json<Value>> {
    let _write = s.writes.lock().await;
    input.config.tables()?;
    if serde_json::to_vec_pretty(&input.config)
        .map_err(anyhow::Error::from)?
        .len()
        + 1
        > MAX_CONFIG
    {
        return Err(fail(StatusCode::BAD_REQUEST, "configuration too large"));
    }
    let base = crate::read_cfg(&s.config)?;
    if revision(&base) != input.revision {
        return Err(fail(
            StatusCode::CONFLICT,
            "配置已被其他窗口或命令行修改。请刷新后重试。",
        ));
    }
    let saved = backup(s, &base)?;
    let result = if input.offline {
        (|| -> Result<()> {
            let _lock = control::lock(&s.config)?;
            ensure!(
                !control::socket_path(&s.config).exists(),
                "内核可能仍在运行，请使用在线保存"
            );
            ensure!(
                revision(&crate::read_cfg(&s.config)?) == input.revision,
                "configuration changed concurrently"
            );
            control::atomic_config(&s.config, &input.config)
        })()
    } else {
        match control::request(
            &s.config,
            control::Request {
                action: "apply".into(),
                config: Some(input.config.clone()),
                base: Some(serde_json::to_value(&base).map_err(anyhow::Error::from)?),
            },
        )
        .await
        {
            Ok(r) if r.ok => Ok(()),
            Ok(r) => Err(anyhow::anyhow!(r.message)),
            Err(e) => Err(e.context("无法提交到内核；若服务已停止，请显式选择离线保存")),
        }
    };
    match result {
        Ok(()) => {
            event(
                s,
                reason,
                &format!(
                    "{} → {} 条规则；变更前备份 {}{}",
                    base.rules.len(),
                    input.config.rules.len(),
                    saved,
                    if input.offline {
                        "；离线保存"
                    } else {
                        "；已热加载"
                    }
                ),
            )
            .await;
            Ok(Json(
                json!({"ok":true,"revision":revision(&input.config),"backup":saved}),
            ))
        }
        Err(e) => {
            event(s, "apply_failed", &format!("{e:#}")).await;
            Err(e.into())
        }
    }
}
async fn apply(
    State(s): State<Shared>,
    h: HeaderMap,
    Json(input): Json<Apply>,
) -> Api<Json<Value>> {
    auth(&s, &h, true).await?;
    apply_inner(&s, input, "config_applied").await
}
async fn backups(State(s): State<Shared>, h: HeaderMap) -> Api<Json<Value>> {
    auth(&s, &h, false).await?;
    let list=snapshots(&s)?.into_iter().map(|p|{let cfg=crate::read_cfg(&p)?;Ok(json!({"id":p.file_stem().unwrap().to_string_lossy(),"rules":cfg.rules.len(),"bytes":fs::metadata(&p)?.len()}))}).collect::<Result<Vec<_>>>()?;
    Ok(Json(json!(list)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Restore {
    revision: String,
    #[serde(default)]
    offline: bool,
}
fn backup_path(s: &App, id: &str) -> Result<PathBuf> {
    ensure!(
        id.len() < 64 && id.contains('-') && id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-'),
        "invalid backup ID"
    );
    Ok(s.opts.data_dir.join("backups").join(format!("{id}.json")))
}
async fn backup_get(
    State(s): State<Shared>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Api<Json<Config>> {
    auth(&s, &h, false).await?;
    Ok(Json(crate::read_cfg(&backup_path(&s, &id)?)?))
}
async fn restore(
    State(s): State<Shared>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<Restore>,
) -> Api<Json<Value>> {
    auth(&s, &h, true).await?;
    let config = crate::read_cfg(&backup_path(&s, &id)?)?;
    apply_inner(
        &s,
        Apply {
            config,
            revision: input.revision,
            offline: input.offline,
        },
        "backup_restored",
    )
    .await
}
async fn audit(State(s): State<Shared>, h: HeaderMap) -> Api<Json<Value>> {
    auth(&s, &h, false).await?;
    Ok(Json(json!(
        s.history
            .lock()
            .await
            .events
            .iter()
            .rev()
            .collect::<Vec<_>>()
    )))
}
async fn service(
    State(s): State<Shared>,
    h: HeaderMap,
    Path(action): Path<String>,
) -> Api<Json<Value>> {
    auth(&s, &h, true).await?;
    if !s.opts.manage_service {
        return Err(fail(StatusCode::FORBIDDEN, "此部署未启用服务控制"));
    }
    if !["start", "stop", "restart"].contains(&action.as_str()) {
        return Err(fail(StatusCode::BAD_REQUEST, "无效的服务操作"));
    }
    let _write = s.writes.lock().await;
    let output = tokio::time::timeout(
        Duration::from_secs(20),
        tokio::process::Command::new("/usr/bin/sudo")
            .args(["-n", "/usr/bin/systemctl", &action, "host-router.service"])
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| fail(StatusCode::GATEWAY_TIMEOUT, "服务操作超时，请检查运行状态"))?
    .map_err(anyhow::Error::from)?;
    let success = output.status.success();
    event(
        &s,
        "service",
        &format!("{action}: {}", if success { "成功" } else { "失败" }),
    )
    .await;
    if !success {
        return Err(fail(
            StatusCode::BAD_GATEWAY,
            "服务操作失败，请检查 systemd 服务和授权配置",
        ));
    }
    Ok(Json(json!({"ok":true})))
}
pub async fn serve(config: PathBuf, mut opts: Options) -> Result<()> {
    ensure!(
        opts.listen.ip().is_loopback() || opts.allow_public_http,
        "non-loopback HTTP requires explicit --allow-public-http"
    );
    opts.origin = opts.origin.trim_end_matches('/').into();
    let uri: axum::http::Uri = opts.origin.parse()?;
    ensure!(
        matches!(uri.scheme_str(), Some("http" | "https"))
            && uri.authority().is_some()
            && uri.path() == "/"
            && uri.query().is_none(),
        "origin must be http(s)://host[:port]"
    );
    ensure!(
        opts.base_path.starts_with('/')
            && opts.base_path.ends_with('/')
            && !opts.base_path.contains("//")
            && opts
                .base_path
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"/-_".contains(&c)),
        "base-path must be / or /path/"
    );
    initialize(&opts.data_dir)?;
    let _lock = control::lock(&opts.data_dir.join("panel.json"))?;
    fs::create_dir_all(opts.data_dir.join("backups"))?;
    let admin: Admin = serde_json::from_slice(&fs::read(opts.data_dir.join("admin.json"))?)?;
    let history = match fs::read(opts.data_dir.join("audit.json")) {
        Ok(b) => serde_json::from_slice(&b)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => History::default(),
        Err(e) => return Err(e.into()),
    };
    crate::read_cfg(&config)?;
    let s = Arc::new(App {
        config,
        opts: opts.clone(),
        auth: Mutex::new(Auth {
            admin,
            sessions: HashMap::new(),
            attempts: vec![],
        }),
        writes: Mutex::new(()),
        history: Mutex::new(history),
    });
    let app = Router::new()
        .route(
            "/",
            get(|| async { axum::response::Html(include_str!("../web-panel/index.html")) }),
        )
        .route(
            "/app.css",
            get(|| async {
                (
                    [("content-type", "text/css; charset=utf-8")],
                    include_str!("../web-panel/app.css"),
                )
            }),
        )
        .route(
            "/app.js",
            get(|| async {
                (
                    [("content-type", "text/javascript; charset=utf-8")],
                    include_str!("../web-panel/app.js"),
                )
            }),
        )
        .route("/api/login", post(login))
        .route("/api/me", get(me))
        .route("/api/logout", post(logout))
        .route("/api/password", post(change_password))
        .route("/api/status", get(status))
        .route("/api/config", get(config_get).put(apply))
        .route("/api/validate", post(validate))
        .route("/api/backups", get(backups))
        .route("/api/backups/{id}", get(backup_get).post(restore))
        .route("/api/audit", get(audit))
        .route("/api/service/{action}", post(service))
        .layer(DefaultBodyLimit::max(MAX_CONFIG * 2))
        .layer(middleware::from_fn_with_state(s.clone(), guard))
        .with_state(s);
    let app = if opts.base_path == "/" {
        app
    } else {
        Router::new().nest(&opts.base_path, app)
    };
    let listener = tokio::net::TcpListener::bind(opts.listen).await?;
    tracing::info!(address=%opts.listen,"administration panel listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("signal");
            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
        })
        .await?;
    Ok(())
}
// Alias keeps the configuration path argument and route handler unambiguous.
use config as config_get;
