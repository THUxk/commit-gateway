#!/bin/bash

curl -X POST https://api.yourschool.cc.cd/comment \
  -H "Content-Type: application/json" \
  -d '{
    "content": "eyJuYW1lIjoiQ3VybCBUZXN0IiwgInRpbWVzdGFtcCI6IjIwMjYtMDYtMDJUMTA6MzA6MDBaIn0=",
    "encoding": "base64",
    "message": "Add file via curl"
  }'