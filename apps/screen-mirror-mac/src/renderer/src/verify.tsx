import { createRoot } from 'react-dom/client';

import App from './App';
import './styles/verify.css';

const container = document.getElementById('root');
if (!container) throw new Error('未找到 #root 挂载点');

// 不启用 StrictMode：本页有截图加载与节点测量等副作用，
// 双调用会让这些逻辑在开发期出现难以定位的重复执行。
createRoot(container).render(<App />);
