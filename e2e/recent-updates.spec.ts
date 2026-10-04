import {enterDemo,expect,test} from './fixtures';
import type {Page} from '@playwright/test';

async function onboard(page:Page,name:string) {
  await page.goto('/');await enterDemo(page);
  await page.getByLabel('Name',{exact:true}).fill(name);
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await expect(page.getByRole('navigation',{name:'Primary'})).toBeVisible();
}
async function post(page:Page,text:string) {
  await page.getByRole('navigation').getByRole('button',{name:'Posts',exact:true}).click();
  await page.getByRole('button',{name:/Post an update/}).click();
  if (await page.getByRole('button',{name:'Change',exact:true}).isVisible()) await page.getByRole('button',{name:'Change',exact:true}).click();
  const placeSearch=page.getByPlaceholder(/Search places/);
  if (await placeSearch.isVisible()) {
    await placeSearch.fill('Shapiro');
    await page.getByRole('button',{name:/Shapiro Undergraduate Library/}).first().click();
  }
  await page.getByLabel('Update',{exact:true}).fill(text);
  await page.getByRole('button',{name:'Post update',exact:true}).click();
  await expect(page.locator('article.card').filter({hasText:text})).toBeVisible();
}
test('a question immediately shows recent posts and streams additions and removals',async({browser})=>{
  const authorContext=await browser.newContext();const askerContext=await browser.newContext();
  try {
    const tag=Date.now().toString(36);
    const author=await authorContext.newPage(),asker=await askerContext.newPage();
    await onboard(author,`same_${tag}`);await onboard(asker,`same_${tag}`);
    await author.getByRole('navigation').getByRole('button',{name:'You',exact:true}).click();
    await author.getByLabel('Location',{exact:true}).selectOption({label:'Shapiro Undergraduate Library'});
    await post(author,'Shapiro is pretty empty. Good time to study.');
    await author.getByRole('navigation').getByRole('button',{name:'You',exact:true}).click();
    await author.getByLabel('Location',{exact:true}).selectOption({label:'Michigan Union'});
    await asker.getByLabel('Question',{exact:true}).fill("How's Shapiro looking? Any seats or nah?");
    await asker.locator('form.ask').getByRole('button',{name:'Ask',exact:true}).click();
    await expect(asker).toHaveURL(/#\/q\/\d+/);
    const updates=asker.getByRole('region',{name:'Recent updates'});
    await expect(updates.getByText('Shapiro is pretty empty. Good time to study.',{exact:true})).toBeVisible({timeout:5000});
    await expect(asker.getByRole('button',{name:'Cancel this question'})).toBeVisible();
    await post(author,'Second floor still has room.');
    await expect(updates.getByText('Second floor still has room.',{exact:true})).toBeVisible({timeout:5000});
    const card=author.locator('article.card').filter({hasText:'Shapiro is pretty empty. Good time to study.'});
    await card.getByRole('button',{name:/Comment/}).click();
    await card.getByRole('button',{name:'Delete',exact:true}).click();
    await expect(updates.getByText('Shapiro is pretty empty. Good time to study.',{exact:true})).toHaveCount(0);
  } finally {await authorContext.close();await askerContext.close();}
});
