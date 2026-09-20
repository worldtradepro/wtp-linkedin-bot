# 全自动发布：一次性设置（约 10 分钟）

流程：GitHub 每天 04:00 UTC 自动跑 → 选内容、做图 → 推送到 Buffer（`draft` 草稿 / `schedule` 定时）→ Buffer 按时间发到 LinkedIn。
出错时该次运行变红，GitHub 会给你发邮件。

## 1. 在 GitHub 新建仓库
- 名称随意（例如 `wtp-linkedin-bot`），**选 Public（公开）**。
  - 原因：我们自己做的卡片图要放在仓库的 `images` 分支上，Buffer 需要能公开访问图片链接。
  - 仓库里**没有任何密钥**（密钥只放在 GitHub 的 Secrets 里），公开是安全的。
- 不要勾选 “Add a README / .gitignore / license”，保持空仓库。

## 2. 把这个文件夹推上去
在 `linkedin_bot` 文件夹里的终端运行（把 `你的用户名/仓库名` 换成真实的）：

```bash
git init
git add -A
git commit -m "initial"
git branch -M main
git remote add origin https://github.com/你的用户名/仓库名.git
git push -u origin main
```

`.gitignore` 已经排除了 `node_modules`、`queue`（每天生成的图片）、备份文件。

## 3. 设置两个密钥（你自己粘贴，我不会看到）
仓库页面 → **Settings → Secrets and variables → Actions → New repository secret**：

| 名称 | 内容 |
|---|---|
| `BUFFER_API_KEY` | 在 https://publish.buffer.com/settings/api 生成的密钥 |
| `WTP_BOT_SECRET` | 你网站的 `WTP_OPPS_SECRET`（在 `wtp-local/snippet_38_dump.txt` 第 37 行 / `wtp_monitor/geo_tagger.py` 里可以找到值） |

## 4. 打开 Actions 的写权限
**Settings → Actions → General → Workflow permissions → 选 “Read and write permissions” → Save。**

## 5. 第一次试跑（草稿模式，安全）
- `config.json` 里 `buffer.pushMode` 现在是 `"draft"`：推送到 Buffer 的**草稿箱**，不会真的发出去。
- 仓库页面 → **Actions → linkedin-daily → Run workflow**。
- 几分钟后：Buffer → Publish → 各频道 → Drafts 里看到当天的帖子，检查文字、配图、链接。

## 6. 改成全自动
确认草稿没问题后，把 `config.json` 里的 `"pushMode": "draft"` 改成 `"schedule"`，提交推送。之后每天自动排进 Buffer，Buffer 按 `07:30 / 11:00 / 15:30`（主页面）、`09:00 / 14:00`、每日卡 `11:30`、周一每周卡 `08:00`（Infrastructure）这些 UTC 时间发出。

## 暂停 / 恢复
仓库 **Settings → Secrets and variables → Actions → Variables** 新建变量 `BOT_PAUSED`，值为 `true` → 立即暂停整个流程；删掉或改成别的值 → 恢复。

## 常见问题
- **运行变红**：点进去看是哪一步。常见原因：密钥没设、Buffer 密钥失效、网站接口暂时打不开。
- **Buffer 免费版**：每个频道最多同时排队 10 条；每天补队列的做法够用。
- **发布时间**是 UTC，读者主要时区确定后，在 `config.json` 里改 `slotsUtc`。
