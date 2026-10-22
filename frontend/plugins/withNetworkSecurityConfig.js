/**
 * Permite HTTP en claro solo hacia el backend local
 * (127.0.0.1 / localhost / 10.0.2.2, junto con `adb reverse tcp:8000`).
 * Persistente: se aplica en cada `npx expo prebuild` (CNG).
 */
const {
  withAndroidManifest,
  withDangerousMod,
  AndroidConfig,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const NETWORK_SECURITY_CONFIG_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">localhost</domain>
    <domain includeSubdomains="false">10.0.2.2</domain>
  </domain-config>
</network-security-config>`;

function withNetworkSecurityConfig(config) {
  config = withDangerousMod(config, [
    'android',
    async (modConfig) => {
      const resXmlDir = path.join(
        modConfig.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
        'xml'
      );
      fs.mkdirSync(resXmlDir, { recursive: true });
      fs.writeFileSync(
        path.join(resXmlDir, 'network_security_config.xml'),
        NETWORK_SECURITY_CONFIG_XML
      );
      return modConfig;
    },
  ]);

  config = withAndroidManifest(config, (modConfig) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(
      modConfig.modResults
    );
    application.$['android:networkSecurityConfig'] =
      '@xml/network_security_config';
    return modConfig;
  });

  return config;
}

module.exports = withNetworkSecurityConfig;
