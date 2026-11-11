# Local Firebase emulators (Auth + Firestore) for development only.
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-17-jre-headless \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g firebase-tools@14
WORKDIR /workspace
EXPOSE 4000 8080 9099
CMD ["firebase", "emulators:start", "--project", "demo-invoice", "--only", "auth,firestore", "--import", "/data", "--export-on-exit", "/data"]
