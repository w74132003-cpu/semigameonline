# WaferRun 課堂版（像 Kahoot 的半導體上班遊戲）

老師開一個房間，學生用手機或電腦輸入 4 個字母的房號加入，全班在同一段時間玩同一款《WaferRun》，
結束後老師的畫面會顯示排行榜和頒獎台。

**不需要註冊、不需要網路帳號。** 老師的電腦就是伺服器，學生連到老師的電腦即可。
（遊戲用到的程式庫都放在資料夾裡，沒有對外網路也能玩。）

---
**免責聲明**

1. 本遊戲為教學課堂用，靈感來自於網友《fab24hr 半導體晶圓廠打工人的一天》from Marcel 大大。
2. 並無任何商業或斗內。
3. 內容如有引用錯誤，歡迎告知。

---

**做法 A：用「隧道」把老師的電腦臨時開到網路上（推薦，免註冊、免設定主機）**
1. 照平常方式啟動伺服器（`start.bat` / `start.command`）。
2. 另外安裝 Cloudflare 的免費小工具 `cloudflared`（https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/）。
3. 再開一個終端機，輸入：`cloudflared tunnel --url http://localhost:3000`
4. 它會印出一個公開網址（像 `https://xxxx.trycloudflare.com`）。
5. **老師仍然用 `http://localhost:3000/host` 開主持頁**，在「學生網址」欄貼上這個公開網址，
   QR code 與畫面上的網址就會變成公開網址。把它分享給學生即可。
- 也可以用 ngrok 等同類工具，做法一樣。
- 每次啟動隧道網址都會不一樣，所以每堂課要重貼一次。
- 老師的電腦仍然是伺服器：要開著、不能睡眠，關掉就結束。
- 透過隧道連進來的人**無法**開房，只有老師在 localhost 能開房。

**做法 B：放到雲端主機（固定網址）**
把整個資料夾放到任何能跑 Node.js 且支援 WebSocket 的主機（如 Render、Railway、Fly.io 等），
啟動指令 `node server.js`，並設定環境變數：
- `HOST_PASS`：老師密碼（**一定要設**，開房時要輸入）
- `PUBLIC_URL`：你的網址（選填，設了老師頁面會自動用它產生 QR code）

然後老師用 `https://你的網址/host` 開房即可。
- 注意：房間資料只存在記憶體，主機重新啟動就會消失；有些免費方案閒置會休眠，上課前先打開網址「叫醒」它。

**做法 C：用 GitHub Codespaces（有 GitHub 帳號就能用，免費額度內不用錢）**
1. 在 GitHub 建一個新的儲存庫（可選 Private），把這個資料夾裡的所有檔案上傳進去。
2. 儲存庫頁面按綠色「Code」→「Codespaces」→「Create codespace on main」，等它開好（第一次約 1 分鐘）。
3. 在下方的終端機輸入：`bash codespace-start.sh`
4. 終端機會印出**學生網址**、**老師頁面**和**老師密碼**。用「老師頁面」的網址開房，輸入老師密碼。
5. 如果學生打不開：點下方「連接埠」（Ports）分頁，在 3000 那一列按右鍵 →「連接埠可見度」→ 選 **Public**。
- 想固定老師密碼：GitHub 右上頭像 → Settings → Codespaces → Secrets，新增名為 `HOST_PASS` 的 secret。
- Codespace 閒置一段時間會自動關機（預設時間較短，可在同一個 Codespaces 設定頁調整），上課前先開好，上課中保持瀏覽器分頁開著。
- 下課後可在 github.com/codespaces 把它停止或刪除，以免耗用免費額度。

## 檔案說明

| 檔案 | 用途 |
|---|---|
| `server.js` | 伺服器（沒有任何外部相依，只用 Node.js 內建功能） |
| `public/host.html` | 老師頁面 |
| `public/index.html` | 學生頁面（就是遊戲本體，加上加入房間／結算功能） |
| `public/three.min.js`、`public/qrcode.js` | 3D 與 QR code 程式庫（MIT 授權，見 `THIRD_PARTY_LICENSES.txt`） |
| `start.bat` / `start.command` / `start.sh` | 啟動檔 |
| `codespace-start.sh` | 在 GitHub Codespaces 內的啟動檔 |

遊戲中的機台、數字與流程都是教學用的虛構簡化設定。

