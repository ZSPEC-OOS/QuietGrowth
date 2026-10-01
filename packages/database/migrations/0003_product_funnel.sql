-- Product + funnel domain (MR §16). Versioned definitions.
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL, primary_url text NOT NULL,
  mode text NOT NULL DEFAULT 'zero_spend' CHECK (mode IN ('zero_spend','controlled_growth','managed_autopilot')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE product_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  version int NOT NULL, status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed')),
  profile jsonb NOT NULL, evidence jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, version)
);
CREATE TABLE plan_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  version int NOT NULL, plans jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, version)
);
CREATE TABLE customer_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name text NOT NULL, definition jsonb NOT NULL, version int NOT NULL DEFAULT 1
);
CREATE TABLE funnel_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  version int NOT NULL, definition jsonb NOT NULL,
  active boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, version)
);
-- At most one active funnel definition per product.
CREATE UNIQUE INDEX funnel_one_active ON funnel_definitions (product_id) WHERE active;

SELECT qg_tenant_table('products');
SELECT qg_tenant_table('product_profiles');
SELECT qg_tenant_table('plan_catalog');
SELECT qg_tenant_table('customer_segments');
SELECT qg_tenant_table('funnel_definitions');
