#!/usr/bin/env bash
# 值·录 一键启动脚本
# 用法：./start.sh 或 npm start

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
VENV_ACTIVATE="$SCRIPT_DIR/../.venv/bin/activate"
ENV_FILE="$BACKEND_DIR/.env"
ENV_EXAMPLE="$BACKEND_DIR/.env.example"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${CYAN}[值·录]${NC} $*"; }
success() { echo -e "${GREEN}[值·录]${NC} $*"; }
warn()    { echo -e "${YELLOW}[值·录]${NC} $*"; }
error()   { echo -e "${RED}[值·录] 错误：${NC}$*" >&2; }

# 读取 .env 中某个 key 的值
read_env() {
    grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '[:space:]' || echo ""
}

# 更新或追加 .env 中的键值
update_env() {
    local key="$1"
    local val="$2"
    if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
        sed -i.bak "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
        rm -f "${ENV_FILE}.bak"
    else
        echo "${key}=${val}" >> "$ENV_FILE"
    fi
}

# 配置向导
setup_env() {
    # 若 .env 不存在则从模板创建
    if [[ ! -f "$ENV_FILE" ]]; then
        if [[ -f "$ENV_EXAMPLE" ]]; then
            cp "$ENV_EXAMPLE" "$ENV_FILE"
            info "已从模板创建 backend/.env"
        else
            touch "$ENV_FILE"
        fi
    fi

    local cur_key cur_url cur_model
    cur_key="$(read_env DASHSCOPE_API_KEY)"
    cur_url="$(read_env AI_BASE_URL)"
    cur_model="$(read_env AI_MODEL)"

    # API Key 未配置或仍为占位符时进入向导
    if [[ -z "$cur_key" || "$cur_key" == "sk-your-key-here" ]]; then
        echo ""
        echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "${BOLD}  值·录 首次配置向导${NC}"
        echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
        echo "  AI 功能（持仓截图识别）需要配置 API Key。"
        echo "  支持任何兼容 OpenAI 接口的服务，例如："
        echo ""
        echo -e "  ${CYAN}阿里云百炼${NC}  https://bailian.console.aliyun.com/"
        echo -e "  ${CYAN}OpenAI${NC}      https://platform.openai.com/api-keys"
        echo -e "  ${CYAN}DeepSeek${NC}    https://platform.deepseek.com/"
        echo -e "  ${CYAN}Moonshot${NC}    https://platform.moonshot.cn/"
        echo ""

        # 输入 API Key
        local input_key=""
        while [[ -z "$input_key" || "$input_key" == "sk-your-key-here" ]]; do
            read -rp "  请输入 API Key: " input_key
            input_key="$(echo "$input_key" | tr -d '[:space:]')"
            if [[ -z "$input_key" || "$input_key" == "sk-your-key-here" ]]; then
                warn "API Key 不能为空，请重新输入。"
            fi
        done

        # 输入模型接口地址（可直接回车跳过）
        local fallback_url="https://dashscope.aliyuncs.com/compatible-mode/v1"
        local default_url="${cur_url:-$fallback_url}"
        echo ""
        echo "  模型接口地址（回车使用默认值）："
        echo "  默认：$default_url"
        local input_url=""
        read -rp "  > " input_url
        input_url="$(echo "$input_url" | tr -d '[:space:]')"
        if [[ -z "$input_url" ]]; then
            input_url="$default_url"
        fi

        # 输入模型名称（可直接回车跳过）
        local fallback_model="qwen-vl-plus"
        local default_model="${cur_model:-$fallback_model}"
        echo ""
        echo "  模型名称（回车使用默认值）："
        echo "  默认：$default_model"
        local input_model=""
        read -rp "  > " input_model
        input_model="$(echo "$input_model" | tr -d '[:space:]')"
        if [[ -z "$input_model" ]]; then
            input_model="$default_model"
        fi

        update_env "DASHSCOPE_API_KEY" "$input_key"
        update_env "AI_BASE_URL" "$input_url"
        update_env "AI_MODEL" "$input_model"

        echo ""
        success "配置已保存到 backend/.env"
        echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
    fi
}

# 退出时清理后台进程
UVICORN_PID=""
cleanup() {
    echo ""
    info "正在停止服务..."
    if [[ -n "$UVICORN_PID" ]] && kill -0 "$UVICORN_PID" 2>/dev/null; then
        kill "$UVICORN_PID"
        info "后端已停止 (PID: $UVICORN_PID)"
    fi
}
trap cleanup EXIT INT TERM

# ─── 主流程 ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}  值·录 投资记录本${NC}"
echo ""

# 1. 配置向导
setup_env

# 2. 检查 Python
if ! command -v python3 &>/dev/null; then
    error "未找到 python3，请先安装 Python 3.9+"
    error "下载地址：https://www.python.org/downloads/"
    exit 1
fi

# 3. 创建虚拟环境（首次运行）
VENV_DIR="$SCRIPT_DIR/../.venv"
if [[ ! -f "$VENV_ACTIVATE" ]]; then
    info "创建 Python 虚拟环境..."
    python3 -m venv "$VENV_DIR"
    success "虚拟环境已创建"
fi

# shellcheck source=/dev/null
source "$VENV_ACTIVATE"
info "Python 虚拟环境已激活"

# 安装/更新 Python 依赖
info "检查 Python 依赖..."
pip install -q -r "$BACKEND_DIR/requirements.txt"
success "Python 依赖已就绪"

# 3. 后台启动后端
info "启动后端服务 (http://localhost:8000) ..."
cd "$BACKEND_DIR"
uvicorn main:app --reload --host 0.0.0.0 --port 8000 &
UVICORN_PID=$!
cd "$SCRIPT_DIR"

# 等待后端就绪（最多 15 秒）
for i in $(seq 1 15); do
    if curl -sf http://localhost:8000/docs > /dev/null 2>&1; then
        success "后端已就绪"
        break
    fi
    sleep 1
    if [[ "$i" -eq 15 ]]; then
        warn "后端启动超时，请检查后端日志"
    fi
done

# 4. 安装前端依赖（首次运行）
if [[ ! -d "$SCRIPT_DIR/node_modules" ]]; then
    info "安装前端依赖..."
    npm install --prefix "$SCRIPT_DIR"
fi

# 5. 前台启动前端
echo ""
info "启动前端开发服务器..."
echo -e "  ${GREEN}前端：${NC}http://localhost:5173"
echo -e "  ${GREEN}后端：${NC}http://localhost:8000"
echo -e "  ${YELLOW}按 Ctrl+C 停止所有服务${NC}"
echo ""
npm run dev --prefix "$SCRIPT_DIR"
