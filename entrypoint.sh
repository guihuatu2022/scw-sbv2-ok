#!/bin/sh
set -e

# Scaleway 会在部署时自动注入 PORT，本地调试时给个默认值
export PORT="${PORT:-8080}"

# 必须由部署时的环境变量提供，缺失就直接失败退出，避免用空 UUID 起服务
if [ -z "${UUID}" ]; then
  echo "ERROR: env UUID is required (VLESS user uuid). Deploy with -e UUID=xxxx-xxxx-...." >&2
  exit 1
fi

# WS_PATH 必须显式设置为高熵随机路径（如 /db/<32位hex>.iso）。
# 本仓库是公开的，若用默认值等于路径公开；故强制要求部署时提供，缺失即失败。
if [ -z "${WS_PATH}" ]; then
  echo "ERROR: env WS_PATH is required. Set a high-entropy random path, e.g. WS_PATH=/db/<32-hex>.iso" >&2
  exit 1
fi

# 排障模式：临时开启 debug 日志，排查完成后改回 error
export LOG_LEVEL="${LOG_LEVEL:-error}"

# 尝试调高最大文件描述符数，应对连接数增多。沙箱环境可能不允许调整，
# 失败也不影响启动（|| true），只是退回平台默认值。
ulimit -n 65535 2>/dev/null || true

# 启动日志：UUID / WS_PATH 均脱敏，避免敏感信息进入平台日志
echo "Starting sing-box: PORT=${PORT} WS_PATH=*** LOG_LEVEL=${LOG_LEVEL} GOMAXPROCS=${GOMAXPROCS} GOMEMLIMIT=${GOMEMLIMIT} ulimit-n=$(ulimit -n)"

mkdir -p /etc/sing-box

# busybox 没有 envsubst，用 sed 替换自定义占位符（@XXX@），
# 比 envsubst 更可控：只替换我们指定的几个 token，不会误伤 JSON 里其他 $ 字符
sed -e "s/@PORT@/${PORT}/g" \
    -e "s/@UUID@/${UUID}/g" \
    -e "s#@WS_PATH@#${WS_PATH}#g" \
    -e "s/@LOG_LEVEL@/${LOG_LEVEL}/g" \
    /etc/sing-box/config.template.json > /etc/sing-box/config.json

# 打印出去除敏感信息后的配置，便于在平台日志里排查启动问题
# UUID 和 WS_PATH 均脱敏
sed -e 's/"uuid": ".*"/"uuid": "***"/' \
    -e 's#"path": ".*"#"path": "***"#' \
    /etc/sing-box/config.json

exec sing-box run -c /etc/sing-box/config.json
