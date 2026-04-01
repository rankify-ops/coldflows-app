-- Coldflows database schema
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor → New query)

-- Customers table — stores business info from onboarding
CREATE TABLE public.customers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  email TEXT NOT NULL,
  business_name TEXT,
  service_description TEXT,
  target_market TEXT,
  plan TEXT DEFAULT 'starter' CHECK (plan IN ('starter', 'growth', 'scale')),
  plan_status TEXT DEFAULT 'pending' CHECK (plan_status IN ('pending', 'active', 'cancelled', 'past_due')),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  mailbox_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

-- Users can only read/update their own row
CREATE POLICY "Users can view own customer data" ON public.customers
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own customer data" ON public.customers
  FOR UPDATE USING (auth.uid() = user_id);

-- Allow insert for authenticated users (for onboarding)
CREATE POLICY "Authenticated users can insert own customer data" ON public.customers
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Auto-create customer row when a new user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.customers (user_id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Updated_at auto-update
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customers_updated_at
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
