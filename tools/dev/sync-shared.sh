#!/bin/sh
# The Python package bundles the schema, the patterns and the licence files so a
# wheel works without the repository, and so an sdist can build a wheel without
# reaching outside its own root. Run this after changing any source file; `npm
# test` fails if they drift.
set -e
cd "$(dirname "$0")/../.."
cp schema/ai-evidence-manifest.schema.json python/ai_evidence/
cp shared/patterns.json python/ai_evidence/
cp LICENSE NOTICE python/
echo "synced python/ from schema/, shared/ and the repository root"
