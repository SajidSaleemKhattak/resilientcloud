FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
WORKDIR /app
RUN mkdir -p /data /audit /run/gate && chown node:node /data
COPY recovery ./recovery
USER node
CMD ["node", "recovery/controller.mjs"]
