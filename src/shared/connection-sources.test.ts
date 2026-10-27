import { describe, expect, it } from 'vitest'
import { parseNavicat, parseSequelAce, parseUrlList, parseWorkbench } from './connection-sources'

describe('parseWorkbench', () => {
  const xml = `<?xml version="1.0"?><data>
<value type="list" content-type="object" key="connections">
<value type="object" struct-name="db.mgmt.Connection" id="a">
  <value type="string" key="name">Local &amp; dev</value>
  <value type="dict" key="parameterValues">
    <value type="string" key="hostName">127.0.0.1</value>
    <value type="int" key="port">3307</value>
    <value type="string" key="schema">shop</value>
    <value type="string" key="userName">root</value>
    <value type="int" key="useSSL">1</value>
  </value>
</value>
<value type="object" struct-name="db.mgmt.Connection" id="b">
  <value type="string" key="name">Via bastion</value>
  <value type="dict" key="parameterValues">
    <value type="string" key="hostName">db.internal</value>
    <value type="string" key="sshHost">bastion:2222</value>
    <value type="string" key="sshUserName">ops</value>
  </value>
</value></value></data>`
  it('reads each connection', () => {
    const { connections } = parseWorkbench(xml)!
    expect(connections[0]).toMatchObject({
      name: 'Local & dev',
      host: '127.0.0.1',
      port: 3307,
      database: 'shop',
      username: 'root',
      tls: true,
    })
    expect(connections[1]).toMatchObject({
      host: 'db.internal',
      port: 3306,
      ssh: { host: 'bastion', port: 2222, username: 'ops' },
    })
    expect(parseWorkbench('<data/>')).toBeNull()
  })
})

describe('parseSequelAce', () => {
  const plist = `<?xml version="1.0"?><plist version="1.0"><dict><key>Favorites</key><array>
<dict><key>name</key><string>Group</string><key>Children</key><array>
<dict><key>name</key><string>Shop</string><key>host</key><string>db.example.com</string><key>port</key><string>3306</string><key>user</key><string>app</string><key>database</key><string>shop</string><key>type</key><integer>0</integer></dict>
<dict><key>name</key><string>Tunnel</string><key>host</key><string>10.0.0.5</string><key>type</key><integer>2</integer><key>sshHost</key><string>jump</string><key>sshUser</key><string>me</string></dict>
</array></dict></array></dict></plist>`
  it('reads favorites inside groups, and skips the groups', () => {
    const { connections } = parseSequelAce(plist)!
    expect(connections.map((c) => c.name)).toEqual(['Shop', 'Tunnel'])
    expect(connections[0]).toMatchObject({
      host: 'db.example.com',
      username: 'app',
      database: 'shop',
    })
    expect(connections[1]!.ssh).toMatchObject({ host: 'jump', username: 'me' })
  })
  it('refuses a binary plist', () => {
    expect(parseSequelAce('bplist00')).toBeNull()
  })
})

describe('parseNavicat', () => {
  const xml = `<Connections Ver="1.5">
<Connection ConnectionName="Main" ConnType="MYSQL" Host="h" Port="3306" UserName="u" Password="AB12" InitialDatabase="d" />
<Connection ConnectionName="PG" ConnType="POSTGRESQL" Host="p" />
</Connections>`
  it('reads connections, decrypting passwords, and lists the ones it cannot open', () => {
    const result = parseNavicat(xml, (hex) => (hex === 'AB12' ? 'secret' : null))!
    expect(result.skipped).toEqual([{ name: 'PG', driver: 'POSTGRESQL' }])
    expect(result.connections[0]).toMatchObject({ name: 'Main', username: 'u', hasPassword: true })
    expect(result.logins['navicat-0']!.connection).toEqual({ user: 'u', password: 'secret' })
  })
})

describe('parseUrlList', () => {
  it('reads one connection per line, with logins, and lists what it cannot read', () => {
    const result = parseUrlList(
      '# my servers\nmysql://root:p%40ss@db:3307/shop\n\nredis://cache\nnonsense\n',
    )
    expect(result.connections.map((c) => [c.engine, c.host, c.port, c.database])).toEqual([
      ['mysql', 'db', 3307, 'shop'],
      ['redis', 'cache', 6379, ''],
    ])
    expect(result.logins['url-0']!.connection).toEqual({ user: 'root', password: 'p@ss' })
    expect(result.skipped).toHaveLength(1)
  })
})
