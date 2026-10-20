-- CreateTable
CREATE TABLE "ShopOrder" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "date" DATE NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "phone" TEXT,
    "total" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PKR',
    "status" TEXT NOT NULL,
    "financial" TEXT,
    "fulfillment" TEXT,
    "tags" TEXT[],
    "adId" TEXT,
    "attribution" TEXT,
    "chatAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopOrder_date_idx" ON "ShopOrder"("date");

-- CreateIndex
CREATE INDEX "ShopOrder_phone_idx" ON "ShopOrder"("phone");

-- CreateIndex
CREATE INDEX "ShopOrder_adId_idx" ON "ShopOrder"("adId");

-- AddForeignKey
ALTER TABLE "ShopOrder" ADD CONSTRAINT "ShopOrder_adId_fkey" FOREIGN KEY ("adId") REFERENCES "Ad"("id") ON DELETE SET NULL ON UPDATE CASCADE;

