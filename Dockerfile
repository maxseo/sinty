FROM node:24-bookworm-slim
WORKDIR /usr/local/sinty
COPY build/stage/ ./
RUN chmod +x bin/sinty && mkdir -p /var/lib/sinty
ENV SINTY_HOME=/var/lib/sinty
ENV SINTY_INSTALL_ROOT=/usr/local/sinty
EXPOSE 3180
VOLUME ["/var/lib/sinty"]
CMD ["node", "packages/cli/dist/bin.js", "web", "--host", "0.0.0.0", "--port", "3180"]
