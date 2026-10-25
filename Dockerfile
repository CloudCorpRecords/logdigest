# logdigest as a container image (GHCR).
# The image runs the same bin as the npm package: dist/cli.js.
# Default command is "mcp", so `docker run -i <image>` is a stdio MCP server;
# any other arguments reach the CLI normally.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["mcp"]
LABEL org.opencontainers.image.source="https://github.com/CloudCorpRecords/logdigest" \
      org.opencontainers.image.description="logdigest: CI log condenser: reads a build or test log and extracts the failure sections, error lines, and failing test names with their original line numbers, so a 10k-line log becomes the 50 lines that matter." \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/logdigest"
