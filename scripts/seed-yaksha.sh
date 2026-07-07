#!/usr/bin/env bash
#
# Idempotent seed of the three default dev accounts.
#
#   admin@yaksha.com    -> admin123   (global role: admin)
#   teacher@yaksha.com  -> teacher123 (global role: user; per-course INSTRUCTOR
#                                          must be assigned manually once a
#                                          course/version exists)
#   user@yaksha.com     -> student123 (global role: user)
#
# Why this exists:
#   Both the Firebase Auth emulator and Mongo `users` collection are wiped on a
#   clean exit of the emulator/mongod processes — without this seed, every fresh
#   ./run.sh would force the user to re-register the same three accounts by
#   hand. With --import/--export-on-exit (run.sh) the state survives restarts,
#   but this seed is the *first-run bootstrap* when the export dir is empty.
#
# Idempotency:
#   - The Firebase REST call returns 400 ALREADY_EXISTS for an existing email,
#     which we treat as success and skip the Mongo insert.
#   - The Mongo insert uses an upsert keyed on email, so a partial-failure
#     scenario (Auth account exists, Mongo user missing) self-heals.
#
# Pre-requisites (set up by run.sh):
#   - Firebase Auth emulator on 127.0.0.1:9099
#   - Mongo replica set on 127.0.0.1:27017, DB_NAME=vibe
#
# Env overrides (all optional):
#   AUTH_EMU   (default http://127.0.0.1:9099)
#   DB_URL     (default mongodb://127.0.0.1:27017/?replicaSet=rs0)
#   DB_NAME    (default vibe)
#   PROJECT_ID (default demo-test)
#
# Read-only: never deletes or overwrites existing accounts. Safe to re-run.

set -u  # unset vars are errors; we don't want missing-config to silently pass.

AUTH_EMU="${AUTH_EMU:-http://127.0.0.1:9099}"
DB_URL="${DB_URL:-mongodb://127.0.0.1:27017/?replicaSet=rs0}"
DB_NAME="${DB_NAME:-vibe}"
PROJECT_ID="${PROJECT_ID:-demo-test}"

# API key is the dummy string the emulator accepts; the Authorization header
# is what actually gates writes (must be "owner" in singleProjectMode).
FAKE_KEY="fake-api-key"

# Wait briefly for Auth emulator if run.sh just started it. Bounded — we don't
# want to hang forever if something else is wrong.
wait_for_auth() {
  local i
  for i in $(seq 1 30); do
    if curl -sf "${AUTH_EMU}/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "❌ Auth emulator at ${AUTH_EMU} did not respond in 30s." >&2
  exit 1
}

# Wait briefly for Mongo replica set primary.
wait_for_mongo() {
  local i
  for i in $(seq 1 30); do
    if mongosh --quiet --eval 'db.adminCommand({ping:1}).ok' "$DB_URL" 2>/dev/null | grep -q '^1$'; then
      return 0
    fi
    sleep 1
  done
  echo "❌ Mongo at ${DB_URL} did not respond in 30s." >&2
  exit 1
}

# Sign up via the Auth emulator REST. Writes ONE of two sentinels to stdout:
#   "__EXISTS__"      — the email is already registered
#   "<28-char localId>" — a fresh account was created
# Real failures exit non-zero; the raw emulator response goes to stderr.
#
# IMPORTANT — password semantics:
#   The emulator's accounts:signUp, when called with an already-registered
#   email, can create a "shadow" link without overwriting the password. We
#   detect ALREADY_EXISTS FIRST and return __EXISTS__, never letting the
#   request reach the success path. To actually reset a password, use the
#   accounts:update endpoint (not implemented here — out of scope for a
#   seed script).
auth_signup() {
  local email="$1" password="$2" first_name="$3" last_name="$4"
  local resp
  resp=$(curl -sS -X POST \
    "${AUTH_EMU}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FAKE_KEY}" \
    -H "Authorization: Bearer owner" \
    -H "Content-Type: application/json" \
    -d "$(printf '{"email":"%s","password":"%s","displayName":"%s %s","returnSecureToken":true}' \
          "$email" "$password" "$first_name" "$last_name")")
  if echo "$resp" | grep -qE '"(EMAIL_EXISTS|ALREADY_EXISTS)"'; then
    echo "__EXISTS__"
    return 0
  fi
  if echo "$resp" | grep -q '"localId"'; then
    echo "$resp" | sed -n 's/.*"localId":"\([^"]*\)".*/\1/p'
    return 0
  fi
  echo "❌ Auth signup failed for ${email}:" >&2
  echo "$resp" >&2
  return 1
}

# Look up an existing email's localId from the Auth emulator. Used when
# EMAIL_EXISTS / ALREADY_EXISTS comes back from signUp so we can reconcile
# the Mongo doc without forcing the user to re-register.
#
# We use accounts:query (the admin-only endpoint that lists everything) rather
# than accounts:lookup — accounts:lookup requires you to already know the
# localId OR provide an explicit email/phone list, and an empty list returns
# zero rows. query is the right tool when you only have an email.
auth_local_id_for() {
  local email="$1"
  curl -sS -X POST \
    "${AUTH_EMU}/identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:query?key=${FAKE_KEY}" \
    -H "Authorization: Bearer owner" \
    -H "Content-Type: application/json" \
    -d '{"returnUserInfo":true}' \
  | python3 -c '
import json, sys
data = json.load(sys.stdin)
for u in data.get("userInfo", []):
    if u.get("email") == sys.argv[1]:
        print(u["localId"])
        sys.exit(0)
sys.exit(1)
' "$email" 2>/dev/null
}

# Upsert one users document. Arguments: email, roles, firstName, lastName,
# firebaseUID. We preserve any existing fields not in our list (e.g. profileImage,
# faceEmbedding) by only setting the ones we know about with $setOnInsert, then
# always refreshing email/firstName/lastName/roles with $set so a re-run after
# a manual fix-up converges correctly.
mongo_upsert_user() {
  local email="$1" roles="$2" first_name="$3" last_name="$4" fbuid="$5"
  mongosh --quiet "$DB_URL" --eval "
    db = db.getSiblingDB('${DB_NAME}');
    const res = db.users.updateOne(
      { email: '${email}' },
      {
        \$set: {
          email: '${email}',
          firstName: '${first_name}',
          lastName: '${last_name}',
          roles: '${roles}',
          firebaseUID: '${fbuid}',
        },
        \$setOnInsert: { faceEmbedding: null, profileImage: null },
      },
      { upsert: true }
    );
    print(res.upsertedCount > 0 ? 'inserted' : 'updated');
  "
}

# ----------------------------------------------------------------------------
# Seed definition. Add new accounts here — keep the list small and intentional.
# Format: email|role|firstName|lastName|password
# ----------------------------------------------------------------------------
SEEDS=(
  "admin@yaksha.com|admin|Admin|User|admin123"
  "teacher@yaksha.com|user|Teacher|User|teacher123"
  "user@yaksha.com|user|Student|User|student123"
)

# ----------------------------------------------------------------------------
# Run
# ----------------------------------------------------------------------------
wait_for_auth
wait_for_mongo

echo "🌱 Seeding default dev accounts..."
inserted=0
skipped=0
for seed in "${SEEDS[@]}"; do
  IFS='|' read -r email role first_name last_name password <<<"$seed"

  # auth_signup prints the new localId to stdout on creation, or the
  # "__EXISTS__" sentinel if the email is already registered. A real localId
  # is 28 chars of base64url; the sentinel can't be confused with one.
  result=$(auth_signup "$email" "$password" "$first_name" "$last_name")
  if [ "$result" = "__EXISTS__" ]; then
    fbuid=$(auth_local_id_for "$email")
    if [ -z "$fbuid" ]; then
      echo "  ⚠️  ${email}: Auth says ALREADY_EXISTS but lookup returned no localId — skipping"
      continue
    fi
    upsert=$(mongo_upsert_user "$email" "$role" "$first_name" "$last_name" "$fbuid" | tail -n1)
    echo "  ✓ ${email} (${role}) — already in Auth, Mongo: ${upsert}"
    skipped=$((skipped+1))
    continue
  fi

  # result is the new localId from a successful signup
  fbuid="$result"
  upsert=$(mongo_upsert_user "$email" "$role" "$first_name" "$last_name" "$fbuid" | tail -n1)
  echo "  ✓ ${email} (${role}) — created in Auth + Mongo: ${upsert}"
  inserted=$((inserted+1))
done

echo
echo "✅ Seed complete. ${inserted} new, ${skipped} pre-existing."
echo
echo "Default credentials (also baked into this script — see scripts/seed-yaksha.sh):"
printf "   %-22s  %-13s  %s\n" "email" "password" "global role"
printf "   %-22s  %-13s  %s\n" "----------------------" "-------------" "------------"
for seed in "${SEEDS[@]}"; do
  IFS='|' read -r email role first_name last_name password <<<"$seed"
  printf "   %-22s  %-13s  %s\n" "$email" "$password" "$role"
done
echo
echo "ℹ️  teacher@yaksha.com is a global 'user'. To act as a teacher it needs to be"
echo "   enrolled in a course version with role=INSTRUCTOR (do that via the UI once"
echo "   you've created at least one course)."