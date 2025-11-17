# 1. 使用官方 Python 基础镜像
FROM python:3.10-slim

# 2. 设置工作目录
WORKDIR /app

# 3. 复制依赖文件
COPY requirements.txt .

# 4. 安装依赖
RUN pip install --no-cache-dir -r requirements.txt

# 5. 复制所有代码
COPY . .

# 6. 设置容器启动时要执行的命令
CMD ["python", "bot.py"]
