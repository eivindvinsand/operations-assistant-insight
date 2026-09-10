import { BrowserRouter, NavLink, Route, Routes } from 'react-router'
import { faChartPie, faGauge } from '@fortawesome/free-solid-svg-icons'
import Bifrost from '@intility/bifrost-react/Bifrost'
import Nav from '@intility/bifrost-react/Nav'
import logo from './assets/logo.png'
import Dashboard from './pages/Dashboard'
import SolutionAgentGroups from './pages/SolutionAgentGroups'

function App() {
  return (
    <Bifrost>
      <BrowserRouter>
        <Nav
          logo={
            <NavLink to="/" className="bf-neutral-link">
              <Nav.Logo logo={logo}>Operations Assistant Insight</Nav.Logo>
            </NavLink>
          }
          side={
            <>
              <NavLink to="/">
                <Nav.Item icon={faGauge}>Dashboard</Nav.Item>
              </NavLink>
              <NavLink to="/solution-agent">
                <Nav.Item icon={faChartPie}>Solution Agent</Nav.Item>
              </NavLink>
            </>
          }
        >
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/solution-agent" element={<SolutionAgentGroups />} />
          </Routes>
        </Nav>
      </BrowserRouter>
    </Bifrost>
  )
}

export default App
