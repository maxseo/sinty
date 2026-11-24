FROM node:24-slim
WORKDIR /app
COPY --chown=node:node . /app/
USER node
ENV HOST=0.0.0.0 PORT=3198
EXPOSE 3198
CMD ["node", "src/main.js"]
