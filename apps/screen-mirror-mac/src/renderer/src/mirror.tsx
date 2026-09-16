import { createRoot } from 'react-dom/client';

import MirrorPage from './pages/MirrorPage';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) throw new Error('未找到 #root 挂载点');

// 不启用 StrictMode：投屏页持有 WebCodecs 解码器与 LiveKit Room 等副作用，
// StrictMode 的双调用会让解码器被重复 configure、Room 被重复 connect。
createRoot(container).render(<MirrorPage />);
