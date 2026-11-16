#!/usr/bin/env bash
# 云构建一键脚本：推送代码 -> 触发 Actions -> 等待 -> 下载 IPA 到桌面
# 前提：gh CLI 已登录（gh auth login），且本机已配置 git 用户
set -euo pipefail

REPO_NAME="${1:-voicereader-ios}"
PROJECT="/Users/lu/WorkBuddy/2026-11-16-00-06-10/VoiceReader"
DESKTOP="/Users/lu/Desktop"
GH="/Users/lu/.local/bin/gh"

echo "==> 1/6 检查 gh 登录状态"
"$GH" auth status || { echo "请先运行: $GH auth login"; exit 1; }

USER="$("$GH" api user --jq .login)"
echo "    账号: $USER"

echo "==> 2/6 初始化 git（如需要）"
cd "$PROJECT"
if [ ! -d .git ]; then
  git init -b main
  git config user.name  "$USER"
  git config user.email "$USER@users.noreply.github.com"
fi

echo "==> 3/6 创建远端仓库（如不存在）并推送"
if "$GH" repo view "$USER/$REPO_NAME" >/dev/null 2>&1; then
  echo "    仓库已存在: $USER/$REPO_NAME"
else
  "$GH" repo create "$REPO_NAME" --private --source=. --push
fi
git add -A
git commit -m "VoiceReader native iOS build" 2>/dev/null || echo "    无新改动"
git branch -M main
git remote add origin "https://github.com/$USER/$REPO_NAME.git" 2>/dev/null || \
  git remote set-url origin "https://github.com/$USER/$REPO_NAME.git"
git push -u origin main

echo "==> 4/6 触发构建"
"$GH" workflow run build-ipa.yml --repo "$USER/$REPO_NAME"

echo "==> 5/6 等待构建完成"
"$GH" run watch --repo "$USER/$REPO_NAME" $( \
  "$GH" run list --repo "$USER/$REPO_NAME" --workflow build-ipa.yml --limit 1 --json databaseId --jq '.[0].databaseId')

echo "==> 6/6 下载 IPA 到桌面"
RUN_ID="$("$GH" run list --repo "$USER/$REPO_NAME" --workflow build-ipa.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
"$GH" run download "$RUN_ID" --repo "$USER/$REPO_NAME" --name VoiceReader-unsigned-ipa --dir "$DESKTOP"
echo "完成：IPA 已下载到 $DESKTOP/VoiceReader-unsigned-ipa/"
ls -lh "$DESKTOP/VoiceReader-unsigned-ipa/" 2>/dev/null || true
