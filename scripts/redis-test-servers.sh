#!/usr/bin/env bash
# Throwaway Redis servers for the live tests, one container each, all named dbide-it-redis-*.
#
#   scripts/redis-test-servers.sh up      pull the images, start the servers, print the variables that point the tests at them
#   scripts/redis-test-servers.sh down    remove them and the certificates
#
# Ports, all on 127.0.0.1: 6390 Redis 7, 6391 Valkey 8, 6392 Redis 5, 6393 Redis 7 with a password and a user
# (default user "secret", alice "apw"), 6394 Redis 7 over TLS, 7000-7002 a three-primary cluster, 16379 and 26380 a
# Redis with a Sentinel watching it. The cluster and the Sentinel announce 127.0.0.1, so they work from this machine.
set -euo pipefail

NAMES="dbide-it-redis-7 dbide-it-redis-valkey dbide-it-redis-5 dbide-it-redis-auth dbide-it-redis-tls dbide-it-redis-cluster dbide-it-redis-sentinel"
TLS_DIR="${DBIDE_TEST_REDIS_TLS_DIR:-${TMPDIR:-/tmp}/dbide-it-redis-tls}"

down() {
  docker rm -f $NAMES >/dev/null 2>&1 || true
  rm -rf "$TLS_DIR"
}

up() {
  down
  mkdir -p "$TLS_DIR"
  (
    cd "$TLS_DIR"
    # A CA, and a server certificate for 127.0.0.1 and localhost.
    openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -subj "/CN=dbide-test-ca" -days 2 >/dev/null 2>&1
    openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=localhost" >/dev/null 2>&1
    printf "subjectAltName=DNS:localhost,IP:127.0.0.1\n" >san.ext
    openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 2 -extfile san.ext >/dev/null 2>&1
    chmod 644 server.key server.crt ca.crt
  )

  docker run -d --name dbide-it-redis-7 -p 127.0.0.1:6390:6379 redis:7 >/dev/null
  docker run -d --name dbide-it-redis-valkey -p 127.0.0.1:6391:6379 valkey/valkey:8 >/dev/null
  docker run -d --name dbide-it-redis-5 -p 127.0.0.1:6392:6379 redis:5 >/dev/null
  docker run -d --name dbide-it-redis-auth -p 127.0.0.1:6393:6379 redis:7 \
    redis-server --requirepass secret --user alice on '>apw' '~*' '&*' '+@all' >/dev/null
  docker run -d --name dbide-it-redis-tls -p 127.0.0.1:6394:6379 -v "$TLS_DIR:/tls:ro" redis:7 \
    redis-server --port 0 --tls-port 6379 --tls-cert-file /tls/server.crt --tls-key-file /tls/server.key \
    --tls-ca-cert-file /tls/ca.crt --tls-auth-clients no >/dev/null
  docker run -d --name dbide-it-redis-cluster -p 127.0.0.1:7000-7002:7000-7002 redis:7 sh -c '
    for p in 7000 7001 7002; do
      redis-server --port $p --cluster-enabled yes --cluster-config-file /tmp/nodes-$p.conf \
        --cluster-announce-ip 127.0.0.1 --cluster-node-timeout 5000 --daemonize yes
    done
    sleep 2
    redis-cli --cluster create 127.0.0.1:7000 127.0.0.1:7001 127.0.0.1:7002 --cluster-replicas 0 --cluster-yes
    tail -f /dev/null' >/dev/null
  docker run -d --name dbide-it-redis-sentinel -p 127.0.0.1:16379:16379 -p 127.0.0.1:26380:26380 redis:7 sh -c '
    redis-server --port 16379 --daemonize yes
    printf "port 26380\nsentinel monitor mymaster 127.0.0.1 16379 1\nsentinel down-after-milliseconds mymaster 5000\n" >/tmp/s.conf
    exec redis-sentinel /tmp/s.conf' >/dev/null

  # Wait until each server answers, and until the cluster has taken its slots.
  for port in 6390 6391 6392 6393 7000 16379; do
    for _ in $(seq 1 40); do
      if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then exec 3>&-; break; fi
      sleep 0.5
    done
  done
  for _ in $(seq 1 40); do
    if docker exec dbide-it-redis-cluster redis-cli -p 7000 cluster info 2>/dev/null | grep -q "cluster_state:ok"; then break; fi
    sleep 0.5
  done

  cat <<VARS
export DBIDE_TEST_REDIS_AUTH_URL=redis://alice:apw@127.0.0.1:6393
export DBIDE_TEST_REDIS_TLS_URL=rediss://127.0.0.1:6394
export DBIDE_TEST_REDIS_CA=$TLS_DIR/ca.crt
export DBIDE_TEST_REDIS_CLUSTER_URL=redis://127.0.0.1:7000
export DBIDE_TEST_REDIS_SENTINEL_URL=redis://127.0.0.1:26380
# One server at a time for DBIDE_TEST_REDIS_URL: 6390 (Redis 7), 6391 (Valkey 8) or 6392 (Redis 5).
VARS
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
