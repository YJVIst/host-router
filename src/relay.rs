use nix::{
    fcntl::{FcntlArg, OFlag, SpliceFFlags, fcntl, splice},
    unistd::pipe2,
};
use std::{io, net::Shutdown};
use tokio::{io::Interest, net::TcpStream};

// Bound the work a busy direction can do before giving other tasks a turn.
// Tokio also budgets readiness operations, but each splice can move many bytes.
const RELAY_BUDGET: usize = 256 * 1024;

async fn direction(src: &TcpStream, dst: &TcpStream) -> io::Result<u64> {
    let (read, write) = pipe2(OFlag::O_NONBLOCK | OFlag::O_CLOEXEC)?;
    // Small/idle streams must not reserve a large share of the per-user pipe
    // capacity. Grow busy directions only after actual traffic (below). Linux
    // rounds this to its page size; resizing is best effort under kernel quotas.
    let _ = fcntl(&write, FcntlArg::F_SETPIPE_SZ(8 * 1024));
    let flags = SpliceFFlags::SPLICE_F_MOVE | SpliceFFlags::SPLICE_F_NONBLOCK;
    let mut total = 0;
    let mut enlarged = false;
    let mut since_yield = 0;
    loop {
        let received = src
            .async_io(Interest::READABLE, || {
                splice(src, None, &write, None, RELAY_BUDGET, flags).map_err(io::Error::from)
            })
            .await?;
        if received == 0 {
            socket2::SockRef::from(dst).shutdown(Shutdown::Write)?;
            return Ok(total);
        }
        let mut remaining = received;
        while remaining > 0 {
            let n = dst
                .async_io(Interest::WRITABLE, || {
                    splice(&read, None, dst, None, remaining, flags).map_err(io::Error::from)
                })
                .await?;
            if n == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "splice returned zero",
                ));
            }
            remaining -= n;
            total += n as u64;
        }
        if !enlarged && total >= 256 * 1024 {
            let _ = fcntl(&write, FcntlArg::F_SETPIPE_SZ(1024 * 1024));
            enlarged = true;
        }
        // Yield only after draining the pipe; do not delay individual small writes.
        since_yield += received;
        if since_yield >= RELAY_BUDGET {
            since_yield = 0;
            tokio::task::yield_now().await;
        }
    }
}
pub async fn copy(a: &TcpStream, b: &TcpStream) -> io::Result<(u64, u64)> {
    tokio::try_join!(direction(a, b), direction(b, a))
}
