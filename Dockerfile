FROM node:16.8.0-alpine3.13
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
RUN cd ./node_modules/lamp-core && npm run build
RUN cd ..
RUN cd ..
RUN npm run build
EXPOSE 3000
CMD ["node", "-r", "source-map-support/register", "./build/app.js"]
