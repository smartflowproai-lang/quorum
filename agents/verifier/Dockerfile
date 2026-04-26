FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY tsconfig.json ./
RUN npm install --omit=dev
COPY *.ts ./
RUN npm install -D typescript && npx tsc && npm prune --omit=dev
CMD ["node", "dist/index.js"]
