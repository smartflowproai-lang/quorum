FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY index.ts ./
COPY tsconfig.json* ./
RUN npm install -g typescript && tsc --allowJs --target es2020 --module commonjs --esModuleInterop --outDir dist index.ts || cp index.ts dist/index.js
CMD ["node", "dist/index.js"]
