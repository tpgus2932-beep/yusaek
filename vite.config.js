import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      // OneDrive 동기화가 backend/DB/문서 파일을 건드릴 때마다 프론트 페이지가
      // 불필요하게 리로드되는 것을 막기 위해 소스와 무관한 경로는 감시에서 제외한다.
      ignored: [
        '**/backend/**',
        '**/docs/**',
        '**/*.db',
        '**/*.sqlite',
        '**/*.sqlite3',
      ],
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    },
  },
})
