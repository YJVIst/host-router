# HTTPS 并发握手与持续转发压测

此夹具只在开发机的独立网络命名空间中使用，所有地址均为回环地址。建议至少有 3 个可用 CPU：转发进程固定到其中 1 个 CPU，测试端使用其他 CPU。需要 Linux、Python 3、iproute2、util-linux 和 Go 1.22+；这些不是 Host Router 的运行依赖。

```bash
go build -o /tmp/hr-tls-load benchmarks/tls-latency/main.go
sudo unshare --net --mount --propagation private \
  python3 tests/tls_latency.py /absolute/path/to/host-router /tmp/hr-tls-new-01 \
  --driver /tmp/hr-tls-load --idle 2000 --bulk 16 --seconds 15 --rate 100 --mbps 6000
```

输出目录必须尚不存在。默认以 nobody 运行转发内核；可通过 --user 指定已有的非 root 测试用户。该用户需要能访问内核、测试驱动和输出目录的父目录。夹具显式设置 65536 的文件描述符限额，避免 runuser 的默认 1024 限额破坏高连接测试。

- 先建立 2000 条持续连接，再启动 16 条持续 HTTP 下载，模拟既有转发负载。
- 持续下载一秒后，每秒发起 100 次全新 TLS 握手；校验夹具证书及 HTTP 响应。没有 TLS 会话恢复缓存。
- --mbps 是所有下载流合计的应用层目标速率，0 表示不限速。以输出的 bulk_gbps 确认实际完成速率。
- 测试期间轮流检查已有连接的心跳，结束后逐条确认全部既有连接仍可用，并等待内核回收连接资源。
- 输出分别包含 TCP 建连、TLS 阶段、总握手和完整 HTTP 请求的 P50/P95/P99，以及错误、吞吐、转发进程 CPU、RSS、FD。

对旧版和候选版交替进行至少三轮，使用同一工具链和相同负载，报告中位数及各轮数据。CPU 为整段负载进程运行期间的平均值，包含建立持久连接、预热和收尾。RSS 不含内核 socket/pipe 内存。

不限速模式用于探索吞吐上限；旧版和新版实际流量可能完全不同，且夹具端的 CPU、回环网络软中断也可能饱和，不能据此直接比较握手延迟。延迟对比应使用相同目标速率并核对实际吞吐。转发内核不终止 TLS，后端加密成本和真实公网链路条件需要另行考虑。

