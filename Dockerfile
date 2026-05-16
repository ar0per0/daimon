FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3010

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node public ./public
COPY --chown=node:node server ./server
COPY --chown=node:node data ./data

RUN chown -R node:node /app
USER node

EXPOSE 3010
VOLUME ["/app/data"]

CMD ["npm", "start"]
