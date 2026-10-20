import vitals from "eslint-config-next/core-web-vitals";

const config = [...vitals, { ignores: [".next/**", "node_modules/**"] }];
export default config;
