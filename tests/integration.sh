#!/usr/bin/env bash
set -uo pipefail

API_URL="${SHRD_API_URL:-https://shrd.stoff.dev}"
CLI_PATH="${SHRD_CLI_PATH:-./cli/target/debug/shrd}"

PASSED=0
FAILED=0
CREATED_IDS=()

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_test() {
	echo -e "${BLUE}[TEST]${NC} $1"
}

log_pass() {
	echo -e "${GREEN}[PASS]${NC} $1"
	((PASSED++))
}

log_fail() {
	echo -e "${RED}[FAIL]${NC} $1"
	((FAILED++))
}

log_info() {
	echo -e "${YELLOW}[INFO]${NC} $1"
}

cleanup() {
	log_info "Cleaning up created shares..."
	for item in "${CREATED_IDS[@]}"; do
		IFS=':' read -r id token <<<"$item"
		curl -s -X DELETE "$API_URL/api/v1/$id" \
			-H "Authorization: Bearer $token" >/dev/null 2>&1 || true
	done
	echo ""
	echo "=========================================="
	echo -e "Results: ${GREEN}$PASSED passed${NC}, ${RED}$FAILED failed${NC}"
	echo "=========================================="
	if [ $FAILED -gt 0 ]; then
		exit 1
	fi
}

trap cleanup EXIT

assert_eq() {
	local expected="$1"
	local actual="$2"
	local msg="$3"
	if [ "$expected" = "$actual" ]; then
		log_pass "$msg"
	else
		log_fail "$msg (expected: '$expected', got: '$actual')"
	fi
}

assert_contains() {
	local haystack="$1"
	local needle="$2"
	local msg="$3"
	if [[ "$haystack" == *"$needle"* ]]; then
		log_pass "$msg"
	else
		log_fail "$msg (expected to contain: '$needle', got: '$haystack')"
	fi
}

assert_not_empty() {
	local value="$1"
	local msg="$2"
	if [ -n "$value" ]; then
		log_pass "$msg"
	else
		log_fail "$msg (expected non-empty value)"
	fi
}

assert_status() {
	local expected="$1"
	local actual="$2"
	local msg="$3"
	if [ "$expected" = "$actual" ]; then
		log_pass "$msg"
	else
		log_fail "$msg (expected status: $expected, got: $actual)"
	fi
}

echo ""
echo "=========================================="
echo "  shrd.sh Integration Test Suite"
echo "=========================================="
echo "API URL: $API_URL"
echo ""

# ===========================================
# HEALTH CHECK
# ===========================================
echo ""
echo "--- Health Check ---"

log_test "GET /health returns 200"
HEALTH=$(curl -s -w "\n%{http_code}" "$API_URL/health")
HEALTH_STATUS=$(echo "$HEALTH" | tail -1)
HEALTH_BODY=$(echo "$HEALTH" | sed '$d')
assert_status "200" "$HEALTH_STATUS" "Health endpoint returns 200"
assert_contains "$HEALTH_BODY" '"status":"ok"' "Health response contains status ok"

# ===========================================
# PUSH ENDPOINT TESTS
# ===========================================
echo ""
echo "--- Push Endpoint Tests ---"

# Test 1: Basic push
log_test "POST /api/v1/push - basic text content"
PUSH_RESP=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/v1/push" \
	-H "Content-Type: application/json" \
	-d '{"content": "Hello, World!"}')
PUSH_STATUS=$(echo "$PUSH_RESP" | tail -1)
PUSH_BODY=$(echo "$PUSH_RESP" | sed '$d')
assert_status "201" "$PUSH_STATUS" "Push returns 201 Created"

PUSH_ID=$(echo "$PUSH_BODY" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
PUSH_TOKEN=$(echo "$PUSH_BODY" | grep -o '"deleteToken":"[^"]*"' | cut -d'"' -f4)
assert_not_empty "$PUSH_ID" "Push returns an ID"
assert_not_empty "$PUSH_TOKEN" "Push returns a delete token"
CREATED_IDS+=("$PUSH_ID:$PUSH_TOKEN")

assert_contains "$PUSH_BODY" '"url":"' "Push returns a URL"
assert_contains "$PUSH_BODY" '"rawUrl":"' "Push returns a raw URL"
assert_contains "$PUSH_BODY" '"deleteUrl":"' "Push returns a delete URL"

# Test 2: Push with JSON content
log_test "POST /api/v1/push - JSON content"
JSON_CONTENT='{"name": "test", "values": [1, 2, 3], "nested": {"key": "value"}}'
PUSH_JSON=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/v1/push" \
	-H "Content-Type: application/json" \
	-d "{\"content\": $(echo "$JSON_CONTENT" | jq -Rs .), \"contentType\": \"application/json\"}")
PUSH_JSON_STATUS=$(echo "$PUSH_JSON" | tail -1)
PUSH_JSON_BODY=$(echo "$PUSH_JSON" | sed '$d')
assert_status "201" "$PUSH_JSON_STATUS" "Push JSON returns 201"
JSON_ID=$(echo "$PUSH_JSON_BODY" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
JSON_TOKEN=$(echo "$PUSH_JSON_BODY" | grep -o '"deleteToken":"[^"]*"' | cut -d'"' -f4)
CREATED_IDS+=("$JSON_ID:$JSON_TOKEN")

# Test 3: Push with filename
log_test "POST /api/v1/push - with filename"
PUSH_FILE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/v1/push" \
	-H "Content-Type: application/json" \
	-d '{"content": "file content here", "filename": "test.txt"}')
PUSH_FILE_STATUS=$(echo "$PUSH_FILE" | tail -1)
assert_status "201" "$PUSH_FILE_STATUS" "Push with filename returns 201"
FILE_ID=$(echo "$PUSH_FILE" | sed '$d' | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
FILE_TOKEN=$(echo "$PUSH_FILE" | sed '$d' | grep -o '"deleteToken":"[^"]*"' | cut -d'"' -f4)
CREATED_IDS+=("$FILE_ID:$FILE_TOKEN")

# Test 4: Push with expiry
log_test "POST /api/v1/push - with expiry (3600 seconds)"
PUSH_EXPIRY=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/v1/push" \
	-H "Content-Type: application/json" \
	-d '{"content": "expires soon", "expiresIn": 3600}')
PUSH_EXPIRY_STATUS=$(echo "$PUSH_EXPIRY" | tail -1)
PUSH_EXPIRY_BODY=$(echo "$PUSH_EXPIRY" | sed '$d')
assert_status "201" "$PUSH_EXPIRY_STATUS" "Push with expiry returns 201"
assert_contains "$PUSH_EXPIRY_BODY" '"expiresAt":"' "Push with expiry returns expiresAt"
EXPIRY_ID=$(echo "$PUSH_EXPIRY_BODY" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
EXPIRY_TOKEN=$(echo "$PUSH_EXPIRY_BODY" | grep -o '"deleteToken":"[^"]*"' | cut -d'"' -f4)
CREATED_IDS+=("$EXPIRY_ID:$EXPIRY_TOKEN")

# Test 5: Push empty content (should fail)
log_test "POST /api/v1/push - empty content (should fail)"
PUSH_EMPTY=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/v1/push" \
	-H "Content-Type: application/json" \
	-d '{"content": ""}')
PUSH_EMPTY_STATUS=$(echo "$PUSH_EMPTY" | tail -1)
assert_status "400" "$PUSH_EMPTY_STATUS" "Push empty content returns 400"

# Test 6: Push no content field (should fail)
log_test "POST /api/v1/push - missing content field (should fail)"
PUSH_MISSING=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/v1/push" \
	-H "Content-Type: application/json" \
	-d '{}')
PUSH_MISSING_STATUS=$(echo "$PUSH_MISSING" | tail -1)
assert_status "400" "$PUSH_MISSING_STATUS" "Push missing content returns 400"

# Test 7: Push large content (50KB)
log_test "POST /api/v1/push - large content (50KB)"
LARGE_CONTENT=$(head -c 51200 /dev/urandom | base64 | tr -d '\n')
PUSH_LARGE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/v1/push" \
	-H "Content-Type: application/json" \
	-d "{\"content\": \"$LARGE_CONTENT\"}")
PUSH_LARGE_STATUS=$(echo "$PUSH_LARGE" | tail -1)
assert_status "201" "$PUSH_LARGE_STATUS" "Push large content returns 201"
LARGE_ID=$(echo "$PUSH_LARGE" | sed '$d' | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
LARGE_TOKEN=$(echo "$PUSH_LARGE" | sed '$d' | grep -o '"deleteToken":"[^"]*"' | cut -d'"' -f4)
CREATED_IDS+=("$LARGE_ID:$LARGE_TOKEN")

# Test 8: Push with special characters
log_test "POST /api/v1/push - special characters"
SPECIAL_CONTENT='Line 1\nLine 2\tTabbed\r\nWindows line\u0000null'
PUSH_SPECIAL=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/v1/push" \
	-H "Content-Type: application/json" \
	-d "{\"content\": \"$SPECIAL_CONTENT\"}")
PUSH_SPECIAL_STATUS=$(echo "$PUSH_SPECIAL" | tail -1)
assert_status "201" "$PUSH_SPECIAL_STATUS" "Push special characters returns 201"
SPECIAL_ID=$(echo "$PUSH_SPECIAL" | sed '$d' | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
SPECIAL_TOKEN=$(echo "$PUSH_SPECIAL" | sed '$d' | grep -o '"deleteToken":"[^"]*"' | cut -d'"' -f4)
CREATED_IDS+=("$SPECIAL_ID:$SPECIAL_TOKEN")

# Test 9: Push unicode content
log_test "POST /api/v1/push - unicode content"
PUSH_UNICODE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/v1/push" \
	-H "Content-Type: application/json" \
	-d '{"content": "Hello 世界 🌍 Привет мир"}')
PUSH_UNICODE_STATUS=$(echo "$PUSH_UNICODE" | tail -1)
assert_status "201" "$PUSH_UNICODE_STATUS" "Push unicode content returns 201"
UNICODE_ID=$(echo "$PUSH_UNICODE" | sed '$d' | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
UNICODE_TOKEN=$(echo "$PUSH_UNICODE" | sed '$d' | grep -o '"deleteToken":"[^"]*"' | cut -d'"' -f4)
CREATED_IDS+=("$UNICODE_ID:$UNICODE_TOKEN")

# ===========================================
# GET CONTENT TESTS
# ===========================================
echo ""
echo "--- Get Content Tests ---"

# Test 10: Get content - raw endpoint
log_test "GET /:id/raw - retrieve raw content"
RAW_CONTENT=$(curl -s "$API_URL/$PUSH_ID/raw")
assert_eq "Hello, World!" "$RAW_CONTENT" "Raw content matches original"

# Test 11: Get content - default endpoint with text/plain accept
log_test "GET /:id - with Accept: text/plain"
PLAIN_CONTENT=$(curl -s -H "Accept: text/plain" "$API_URL/$PUSH_ID")
assert_eq "Hello, World!" "$PLAIN_CONTENT" "Plain content matches original"

# Test 12: Get content - with Accept: text/html (returns metadata)
log_test "GET /:id - with Accept: text/html (returns metadata)"
HTML_RESP=$(curl -s -H "Accept: text/html" "$API_URL/$PUSH_ID")
assert_contains "$HTML_RESP" '"id":"' "HTML accept returns metadata with id"
assert_contains "$HTML_RESP" '"contentType":' "HTML accept returns contentType"

# Test 13: Get JSON content
log_test "GET /:id/raw - retrieve JSON content"
JSON_RAW=$(curl -s "$API_URL/$JSON_ID/raw")
assert_eq "$JSON_CONTENT" "$JSON_RAW" "JSON content matches original"

# Test 14: Get large content
log_test "GET /:id/raw - retrieve large content"
LARGE_RAW=$(curl -s "$API_URL/$LARGE_ID/raw")
assert_eq "$LARGE_CONTENT" "$LARGE_RAW" "Large content matches original"

# Test 15: Get unicode content
log_test "GET /:id/raw - retrieve unicode content"
UNICODE_RAW=$(curl -s "$API_URL/$UNICODE_ID/raw")
assert_eq "Hello 世界 🌍 Привет мир" "$UNICODE_RAW" "Unicode content matches original"

# Test 16: Get non-existent content
log_test "GET /:id/raw - non-existent ID (should 404)"
NOTFOUND=$(curl -s -w "\n%{http_code}" "$API_URL/nonexistent123/raw")
NOTFOUND_STATUS=$(echo "$NOTFOUND" | tail -1)
assert_status "404" "$NOTFOUND_STATUS" "Non-existent ID returns 404"

# ===========================================
# METADATA TESTS
# ===========================================
echo ""
echo "--- Metadata Tests ---"

# Test 17: Get metadata
log_test "GET /:id/meta - retrieve metadata"
META=$(curl -s "$API_URL/$PUSH_ID/meta")
assert_contains "$META" '"id":"'"$PUSH_ID"'"' "Metadata contains correct ID"
assert_contains "$META" '"contentType":' "Metadata contains contentType"
assert_contains "$META" '"size":' "Metadata contains size"
assert_contains "$META" '"createdAt":' "Metadata contains createdAt"
assert_contains "$META" '"views":' "Metadata contains views"

# Test 18: Metadata for content with filename
log_test "GET /:id/meta - content with filename"
FILE_META=$(curl -s "$API_URL/$FILE_ID/meta")
assert_contains "$FILE_META" '"filename":"test.txt"' "Metadata contains filename"

# Test 19: Metadata for content with expiry
log_test "GET /:id/meta - content with expiry"
EXPIRY_META=$(curl -s "$API_URL/$EXPIRY_ID/meta")
assert_contains "$EXPIRY_META" '"expiresAt":' "Metadata contains expiresAt"

# Test 20: Metadata for non-existent content
log_test "GET /:id/meta - non-existent ID (should 404)"
META_NOTFOUND=$(curl -s -w "\n%{http_code}" "$API_URL/nonexistent123/meta")
META_NOTFOUND_STATUS=$(echo "$META_NOTFOUND" | tail -1)
assert_status "404" "$META_NOTFOUND_STATUS" "Non-existent metadata returns 404"

# Test 21: View count increments
log_test "View count increments on access"
META_BEFORE=$(curl -s "$API_URL/$PUSH_ID/meta")
VIEWS_BEFORE=$(echo "$META_BEFORE" | grep -o '"views":[0-9]*' | cut -d':' -f2)
curl -s "$API_URL/$PUSH_ID/raw" >/dev/null
sleep 1
META_AFTER=$(curl -s "$API_URL/$PUSH_ID/meta")
VIEWS_AFTER=$(echo "$META_AFTER" | grep -o '"views":[0-9]*' | cut -d':' -f2)
if [ "$VIEWS_AFTER" -gt "$VIEWS_BEFORE" ]; then
	log_pass "View count incremented (before: $VIEWS_BEFORE, after: $VIEWS_AFTER)"
else
	log_fail "View count did not increment (before: $VIEWS_BEFORE, after: $VIEWS_AFTER)"
fi

# ===========================================
# DELETE TESTS
# ===========================================
echo ""
echo "--- Delete Tests ---"

# Create a share to delete
DELETE_TEST=$(curl -s -X POST "$API_URL/api/v1/push" \
	-H "Content-Type: application/json" \
	-d '{"content": "delete me"}')
DELETE_ID=$(echo "$DELETE_TEST" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
DELETE_TOKEN=$(echo "$DELETE_TEST" | grep -o '"deleteToken":"[^"]*"' | cut -d'"' -f4)

# Test 22: Delete without auth (should fail)
log_test "DELETE /api/v1/:id - without auth (should fail)"
DEL_NOAUTH=$(curl -s -w "\n%{http_code}" -X DELETE "$API_URL/api/v1/$DELETE_ID")
DEL_NOAUTH_STATUS=$(echo "$DEL_NOAUTH" | tail -1)
assert_status "401" "$DEL_NOAUTH_STATUS" "Delete without auth returns 401"

# Test 23: Delete with wrong token (should fail)
log_test "DELETE /api/v1/:id - wrong token (should fail)"
DEL_WRONG=$(curl -s -w "\n%{http_code}" -X DELETE "$API_URL/api/v1/$DELETE_ID" \
	-H "Authorization: Bearer wrongtoken123")
DEL_WRONG_STATUS=$(echo "$DEL_WRONG" | tail -1)
assert_status "403" "$DEL_WRONG_STATUS" "Delete with wrong token returns 403"

# Test 24: Delete with correct token
log_test "DELETE /api/v1/:id - with correct token"
DEL_OK=$(curl -s -w "\n%{http_code}" -X DELETE "$API_URL/api/v1/$DELETE_ID" \
	-H "Authorization: Bearer $DELETE_TOKEN")
DEL_OK_STATUS=$(echo "$DEL_OK" | tail -1)
assert_status "200" "$DEL_OK_STATUS" "Delete with correct token returns 200"

# Test 25: Verify deleted content is gone
log_test "GET /:id/raw - after delete (should 404)"
AFTER_DELETE=$(curl -s -w "\n%{http_code}" "$API_URL/$DELETE_ID/raw")
AFTER_DELETE_STATUS=$(echo "$AFTER_DELETE" | tail -1)
assert_status "404" "$AFTER_DELETE_STATUS" "Deleted content returns 404"

# Test 26: Delete non-existent content
log_test "DELETE /api/v1/:id - non-existent (should fail)"
DEL_NOTFOUND=$(curl -s -w "\n%{http_code}" -X DELETE "$API_URL/api/v1/nonexistent123" \
	-H "Authorization: Bearer sometoken")
DEL_NOTFOUND_STATUS=$(echo "$DEL_NOTFOUND" | tail -1)
assert_status "403" "$DEL_NOTFOUND_STATUS" "Delete non-existent returns 403"

# ===========================================
# CORS TESTS
# ===========================================
echo ""
echo "--- CORS Tests ---"

# Test 27: CORS headers present
log_test "CORS headers present on responses"
CORS_RESP=$(curl -s -I "$API_URL/health")
if echo "$CORS_RESP" | grep -qi "access-control-allow-origin"; then
	log_pass "CORS Access-Control-Allow-Origin header present"
else
	log_fail "CORS Access-Control-Allow-Origin header missing"
fi

# Test 28: OPTIONS preflight
log_test "OPTIONS preflight request"
OPTIONS_RESP=$(curl -s -w "\n%{http_code}" -X OPTIONS "$API_URL/api/v1/push" \
	-H "Origin: https://example.com" \
	-H "Access-Control-Request-Method: POST")
OPTIONS_STATUS=$(echo "$OPTIONS_RESP" | tail -1)
if [ "$OPTIONS_STATUS" = "200" ] || [ "$OPTIONS_STATUS" = "204" ]; then
	log_pass "OPTIONS preflight returns success"
else
	log_fail "OPTIONS preflight failed (status: $OPTIONS_STATUS)"
fi

# ===========================================
# EDGE CASES
# ===========================================
echo ""
echo "--- Edge Cases ---"

# Test 29: Very long ID (should 404)
log_test "GET with very long ID (should 404)"
LONG_ID=$(head -c 1000 /dev/urandom | base64 | tr -dc 'a-z0-9' | head -c 100)
LONG_RESP=$(curl -s -w "\n%{http_code}" "$API_URL/$LONG_ID/raw")
LONG_STATUS=$(echo "$LONG_RESP" | tail -1)
assert_status "404" "$LONG_STATUS" "Very long ID returns 404"

# Test 30: ID with special characters (should 404 or handle gracefully)
log_test "GET with special characters in ID"
SPECIAL_ID_RESP=$(curl -s -w "\n%{http_code}" "$API_URL/../../../etc/passwd/raw")
SPECIAL_ID_STATUS=$(echo "$SPECIAL_ID_RESP" | tail -1)
if [ "$SPECIAL_ID_STATUS" = "404" ] || [ "$SPECIAL_ID_STATUS" = "400" ]; then
	log_pass "Special characters in ID handled safely (status: $SPECIAL_ID_STATUS)"
else
	log_fail "Special characters in ID not handled safely (status: $SPECIAL_ID_STATUS)"
fi

# Test 31: Content-Type header on raw response
log_test "Content-Type header on raw response"
CT_RESP=$(curl -s -I "$API_URL/$PUSH_ID/raw")
if echo "$CT_RESP" | grep -qi "content-type:"; then
	log_pass "Content-Type header present on raw response"
else
	log_fail "Content-Type header missing on raw response"
fi

# Test 32: Invalid JSON in push
log_test "POST /api/v1/push - invalid JSON (should fail)"
INVALID_JSON=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/v1/push" \
	-H "Content-Type: application/json" \
	-d 'not valid json')
INVALID_JSON_STATUS=$(echo "$INVALID_JSON" | tail -1)
assert_status "400" "$INVALID_JSON_STATUS" "Invalid JSON returns 400"

# ===========================================
# PERFORMANCE TESTS
# ===========================================
echo ""
echo "--- Performance Tests ---"

# Test 33: Response time for push
log_test "Push response time < 2000ms"
PUSH_TIME=$(curl -s -o /dev/null -w "%{time_total}" -X POST "$API_URL/api/v1/push" \
	-H "Content-Type: application/json" \
	-d '{"content": "performance test"}')
PUSH_TIME_MS=$(echo "$PUSH_TIME * 1000" | bc | cut -d'.' -f1)
if [ "$PUSH_TIME_MS" -lt 2000 ]; then
	log_pass "Push response time: ${PUSH_TIME_MS}ms"
else
	log_fail "Push response time too slow: ${PUSH_TIME_MS}ms"
fi

# Test 34: Response time for get
log_test "Get response time < 500ms"
GET_TIME=$(curl -s -o /dev/null -w "%{time_total}" "$API_URL/$PUSH_ID/raw")
GET_TIME_MS=$(echo "$GET_TIME * 1000" | bc | cut -d'.' -f1)
if [ "$GET_TIME_MS" -lt 500 ]; then
	log_pass "Get response time: ${GET_TIME_MS}ms"
else
	log_fail "Get response time too slow: ${GET_TIME_MS}ms"
fi

# Test 35: Response time for health
log_test "Health response time < 200ms"
HEALTH_TIME=$(curl -s -o /dev/null -w "%{time_total}" "$API_URL/health")
HEALTH_TIME_MS=$(echo "$HEALTH_TIME * 1000" | bc | cut -d'.' -f1)
if [ "$HEALTH_TIME_MS" -lt 200 ]; then
	log_pass "Health response time: ${HEALTH_TIME_MS}ms"
else
	log_fail "Health response time too slow: ${HEALTH_TIME_MS}ms"
fi

echo ""
echo "=========================================="
echo "  Integration Tests Complete"
echo "=========================================="
