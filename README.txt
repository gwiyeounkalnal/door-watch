[ 밀당금지 - 외부(다른 와이파이/LTE)에서 접속하기 ]

같은 와이파이: npm start  →  https://PC아이피:3000

외부 접속 (Cloudflare 터널, 무료, 회원가입 불필요)
 1) cloudflared 설치: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
 2) 터미널 1:  node server.js --public --password=원하는비번
 3) 터미널 2:  cloudflared tunnel --url http://localhost:3000
 4) 출력되는 https://xxxx.trycloudflare.com 주소를 폰에서 열기
    - 아이디는 비워두고 비밀번호만 입력
    - 정식 https 인증서라 "안전하지 않음" 경고 없이 카메라가 켜집니다.
 * 주소는 터널을 켤 때마다 바뀝니다. 고정 주소는 Cloudflare 계정+도메인이 필요합니다.
 * 서버 PC는 켜져 있고 인터넷에 연결되어 있어야 합니다.
