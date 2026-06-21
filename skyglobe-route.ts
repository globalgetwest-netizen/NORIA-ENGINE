# Render deployment blueprint for the NORIA engine.
# Push this repo to GitHub, then "New + → Blueprint" in Render and point it here.
services:
  - type: web
    name: noria-engine
    runtime: node
    plan: free
    buildCommand: npm install
    startCommand: npm start
    healthCheckPath: /health
    envVars:
      - key: GROQ_API_KEY
        sync: false
      - key: DATABASE_URL
        sync: false
      - key: NORIA_SETUP_SECRET
        sync: false
      - key: ALLOWED_ORIGINS
        sync: false
      - key: BRAVE_SEARCH_API_KEY
        sync: false
      - key: EMBEDDING_DIM
        value: "768"
