# Node + Chromium 运行时，用于在容器内运行真实 baxia SDK 获取 token
# 之所以用 Debian 而不是 alpine：alpine 的 Chromium headless 在容器里依赖/兼容性差
FROM node:24-bookworm-slim

# 安装 ffmpeg + yt-dlp + Chromium（含无头运行所需系统库）
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        yt-dlp \
        chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chromium --version || true

WORKDIR /app

# 复制 package 文件
COPY package*.json ./

# 安装依赖
RUN npm ci --only=production

# 复制源代码
COPY . .

# 容器内以非 root 运行更安全；Chrome 需要 --no-sandbox（baxia-token.js 已带）
ENV NODE_ENV=production
ENV PORT=7860
# 指向 Debian 包的 Chromium 可执行文件
ENV CHROME_PATH=/usr/bin/chromium

EXPOSE 7860

CMD ["node", "index.js"]