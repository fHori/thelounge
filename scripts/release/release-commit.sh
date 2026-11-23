#!/usr/bin/env bash
# Usage: release-commit.sh BASE VERSION TAG EPOCH
#
# Writes the release commit: BASE with package.json's version set to VERSION,
# by github-actions[bot] at EPOCH (seconds, UTC). The same arguments always
# give the same commit, so the plan job can name it before the tests pass and
# the tag job writes that very commit afterwards. Prints its id; touches
# neither the working tree nor HEAD.
set -euo pipefail
base=$1 version=$2 tag=$3 epoch=$4

index=$(mktemp)
trap 'rm -f "$index"' EXIT

blob=$(git show "$base:package.json" \
	| sed -E '0,/"version": "[^"]*"/s//"version": "'"$version"'"/' \
	| git hash-object -w --stdin)
git cat-file -p "$blob" | grep -q "\"version\": \"$version\"" \
	|| { echo "could not set the version in package.json" >&2; exit 1; }

GIT_INDEX_FILE=$index git read-tree "$base"
GIT_INDEX_FILE=$index git update-index --cacheinfo "100644,$blob,package.json"
tree=$(GIT_INDEX_FILE=$index git write-tree)

export GIT_AUTHOR_NAME="github-actions[bot]" GIT_COMMITTER_NAME="github-actions[bot]"
export GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"
export GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
export GIT_AUTHOR_DATE="@$epoch +0000" GIT_COMMITTER_DATE="@$epoch +0000"
git commit-tree "$tree" -p "$base" -m "Release $tag" < /dev/null
