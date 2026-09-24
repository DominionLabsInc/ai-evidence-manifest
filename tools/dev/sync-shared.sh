#!/bin/sh
# The Python package bundles the schema and patterns so a wheel works without
# the repository. Run this after changing either source file; `npm test` fails
# if they drift.
set -e
cd "$(dirname "$0")/../.."
cp schema/ai-evidence-manifest.schema.json python/ai_evidence/
cp shared/patterns.json python/ai_evidence/
echo "synced python/ai_evidence/ from schema/ and shared/"
