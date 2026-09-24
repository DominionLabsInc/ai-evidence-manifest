# A single image carrying the command, for people who would rather not install
# a runtime. Node is used because it is the primary implementation; the Python
# package is published separately on PyPI.
FROM node:22-alpine

WORKDIR /opt/ai-evidence
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY reference-implementation/ ./reference-implementation/
COPY validator/ ./validator/
COPY schema/ ./schema/
COPY shared/ ./shared/
COPY SPEC.md LICENSE LICENSE-APACHE-2.0 NOTICE ./

RUN ln -s /opt/ai-evidence/validator/cli.js /usr/local/bin/ai-evidence \
 && chmod +x /opt/ai-evidence/validator/cli.js

# Runs as a non-root user: the tool fetches attacker-controlled URLs.
USER node
WORKDIR /work
ENTRYPOINT ["ai-evidence"]
CMD ["--help"]
