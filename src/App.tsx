import { BrowserRouter, NavLink, Route, Routes } from 'react-router'
import { faGauge } from '@fortawesome/free-solid-svg-icons'
import Bifrost from '@intility/bifrost-react/Bifrost'
import Nav from '@intility/bifrost-react/Nav'
import logo from './assets/logo.png'
import Dashboard from './pages/Dashboard'

function App() {
  return (
    <Bifrost>
      <BrowserRouter>
        <Nav
          logo={
            <NavLink to="/" className="bf-neutral-link">
              <Nav.Logo logo={logo}>Operations Assistant</Nav.Logo>
            </NavLink>
          }
          side={
            <NavLink to="/">
              <Nav.Item icon={faGauge}>Dashboard</Nav.Item>
            </NavLink>
          }
        >
          <Routes>
            <Route path="/" element={<Dashboard />} />
          </Routes>
        </Nav>
      </BrowserRouter>
    </Bifrost>
  )
}

export default App
