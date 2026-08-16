import { copyFileSync, cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * mermaid 的 ESM 打包产物经 Rollup 二次打包会丢失 default 导出,
 * 改为运行时直载完整 ESM 文件:拷贝到 public/vendor,
 * 组件里 `import('/vendor/mermaid.esm.min.mjs')` 直接取模块命名空间(含 default)。
 */
function vendorMermaid(): Plugin {
  return {
    name: 'vendor-mermaid',
    buildStart() {
      const base = path.dirname(fileURLToPath(import.meta.url));
      const dist = path.join(base, 'node_modules', 'mermaid', 'dist');
      const destDir = path.join(base, 'public', 'vendor');
      mkdirSync(destDir, { recursive: true });
      copyFileSync(path.join(dist, 'mermaid.esm.min.mjs'), path.join(destDir, 'mermaid.esm.min.mjs'));
      // 入口按相对路径引用 ./chunks/mermaid.esm.min/*,必须整目录保留结构
      cpSync(path.join(dist, 'chunks', 'mermaid.esm.min'), path.join(destDir, 'chunks', 'mermaid.esm.min'), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), vendorMermaid()],
  server: {
    port: 3901,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3900', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:3900', ws: true },
    },
  },
});
