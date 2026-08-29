# syntax=docker/dockerfile:1

# ---- 构建阶段：从源码编译，不加任何 -tags，只保留 VLESS + WS 需要的核心功能 ----
FROM golang:1.24-alpine AS builder

ARG SING_BOX_VERSION=v1.13.12
ENV CGO_ENABLED=0 GOOS=linux GOARCH=amd64

# 不加 -tags：VLESS 协议和 WS 传输都是核心内置功能，不依赖 with_quic/with_gvisor/
# with_wireguard/with_utls/with_acme/with_clash_api/with_tailscale/with_grpc 等可选特性。
# 这些可选特性只服务于 QUIC/TUN/WireGuard/Reality/ACME/gRPC/Clash面板——本项目一个都用不到。
RUN go install -trimpath -ldflags "-s -w" \
    github.com/sagernet/sing-box/cmd/sing-box@${SING_BOX_VERSION}

# ---- 运行阶段：busybox 代替 debian-slim，镜像从 ~80MB 降到几 MB ----
FROM busybox:1.36-musl

COPY --from=builder /go/bin/sing-box /usr/local/bin/sing-box
COPY config.template.json /etc/sing-box/config.template.json
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /usr/local/bin/sing-box

# Scaleway 会在部署时把 Port 参数通过 PORT 环境变量注入，这里只是本地调试默认值
# GOMAXPROCS/GOMEMLIMIT/GOGC 是给 128MB/100mCPU 这种极限资源准备的安全阀：
# - GOMAXPROCS=1  避免 Go 运行时按宿主机核心数（而非 cgroup 配额）开线程，浪费调度开销
# - GOMEMLIMIT    堆内存软上限，留出安全余量防止被平台 OOM Kill
# - GOGC=off      关掉按比例触发 GC 的机制，只依赖 GOMEMLIMIT 兜底——
#                 CPU 比内存更紧张时，不必要的高频 GC 反而是在浪费本就稀缺的算力
# GOMEMLIMIT 提到 100MiB，给开 mux 的场景留更多堆余量，减少 GC 尖刺导致的中断重连
ENV PORT=8080 \
    GOMAXPROCS=1 \
    GOMEMLIMIT=100MiB \
    GOGC=off

ENTRYPOINT ["/entrypoint.sh"]
