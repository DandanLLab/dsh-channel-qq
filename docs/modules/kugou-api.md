<div align="center">

🎶 **kugou-api** ｜ [← netease-vip](./netease-vip.md) ｜ [📚 总索引](./README.md) ｜ [life →](./life.md)

</div>

---

# kugou-api.ts — 酷狗音乐

**文件**: `src/kugou-api.ts`（134 行）

## 职责
酷狗搜索/直链/扫码登录——走自部署的 KuGouMusicApi 服务。

## 关键机制
- 服务地址：`KUGOU_API_BASE` 环境变量（默认本地 4000 端口）
- Cookie：`<dshHome>/channel-qq/kugou-cookie.txt`
- VIP 解锁需扫码登录（qq_kugou_login）

## 模块连接
- **上游**: tools.ts（qq_kugou_search/send/login）
- **外部依赖**: KuGouMusicApi 服务（用户自部署）
