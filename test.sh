#!/bin/bash

curl -X POST https://comment-gateway.thuxk.workers.dev/comment \
  -H "Content-Type: application/json" \
  -d '{
    "content": "eyJuYW1lIjoiQ3VybCBUZXN0IiwgInRpbWVzdGFtcCI6IjIwMjYtMDYtMDJUMTA6MzA6MDBaIn0=",
    "encoding": "utf-8",
    "message": "Add file via curl"
  }'