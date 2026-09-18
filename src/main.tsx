import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@intility/bifrost-css/dist/bifrost-all.css'
import '@intility/bifrost-react-datepicker/datepicker.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
