FROM node:20-slim

# FFmpeg es necesario para el reenvio
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 1935 8000
CMD ["npm", "start"]
