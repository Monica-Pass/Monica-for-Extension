## 变更说明

说明用户可见行为、受影响的安全边界和兼容性影响。

## 验证

- [ ] 使用固定 Node/npm 和 `npm ci --ignore-scripts`
- [ ] `npm run release:check` 通过，或明确说明无法运行的外部条件
- [ ] 新增/更新了与风险相称的负向测试
- [ ] 未加入真实秘密、远程代码、source map 或镜像 registry URL
- [ ] Manifest 权限、CSP、消息类型、Provider/导入格式变化已更新安全文档
- [ ] Android 兼容性和现有加密数据读取未被破坏
- [ ] 所有 GitHub Actions 均固定到完整 commit SHA

## 安全评估

列出威胁模型变化、敏感数据流、回滚方式和仍未解决的风险。安全漏洞细节请放在私密 Security Advisory，不要写入公开 PR。
