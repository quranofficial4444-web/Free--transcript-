TubeKit
Structure: server.js (InnerTube proxy) + public/index.html (UI) + package.json.
Run locally (Node 18+):
npm install
npm start        # http://localhost:3000
Deploy on Render: New > Web Service > connect repo > Build npm install > Start npm start.
Deploy on Vercel: npx vercel (vercel.json is included).
Notes:
Replace support@yourdomain.com in public/index.html (Contact dialog).
YouTube may block some datacenter IPs. If transcripts fail after deploying, try another host/region.
